import { createHash } from "node:crypto";
import * as schema from "@cap/database/schema";
import { Organisation, User, Video } from "@cap/web-domain";
import { eq, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { createPool, type Pool } from "mysql2/promise";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { EDIT_TRANSCRIPT_VERSION } from "@/lib/edit-transcript";
import { encryptEditTranscriptObject } from "@/lib/edit-transcript-storage";
import { finishInventoryProbe } from "@/lib/revision-publication";
import {
	ENCODER_PROFILE,
	sourceIdFromIdentity,
} from "@/lib/revision-publication-metadata";
import {
	isUntouchedEditorSpec,
	untouchedEditorSpec,
} from "@/lib/source-prepare";
import {
	decodePeaksObject,
	encodePeaksObject,
	PEAKS_PAIRS_PER_SEC,
	peaksObjectKey,
} from "@/lib/waveform-peaks";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://127.0.0.1:30410" },
	serverEnv: () => ({ NEXTAUTH_SECRET: "parent-worker-fixture-secret" }),
}));
const runtime = vi.hoisted(() => ({
	objects: new Map<string, Buffer>(),
	prepare: vi.fn(),
	publish: vi.fn(),
	refreshPolicy: vi.fn(async () => undefined),
	deletes: [] as string[],
	deleteThrows: 0,
	peaksExistsThrows: false,
	requestPeaks: vi.fn(
		async (_input: {
			videoId: string;
			sourceKey: string;
			sourceSha256: string;
		}): Promise<{
			status: number;
			body: unknown;
			responseBytes: number;
		}> => {
			throw new Error("origin peaks not seamed");
		},
	),
}));
vi.mock("@/lib/instant-finish-source-relocate", async (original) => ({
	...(await original<typeof import("@/lib/instant-finish-source-relocate")>()),
	runtimeObjectStore: () => ({
		sha256: async (key: string) => {
			const body = runtime.objects.get(key);
			return body ? createHash("sha256").update(body).digest("hex") : null;
		},
		copy: async (from: string, to: string) => {
			const body = runtime.objects.get(from);
			if (!body) throw new Error("source missing");
			runtime.objects.set(to, Buffer.from(body));
		},
		deleteAllVersions: async (key: string) => {
			if (runtime.deleteThrows > 0) {
				runtime.deleteThrows -= 1;
				throw new Error("delete failed once");
			}
			runtime.deletes.push(key);
			runtime.objects.delete(key);
		},
		exists: async (key: string) => {
			if (runtime.peaksExistsThrows && key.startsWith("private/peaks/"))
				throw new Error("optional peaks probe failed");
			return runtime.objects.has(key);
		},
		request: async () => 404,
		presignGet: async () => "http://127.0.0.1/not-used",
		list: async (prefix: string) =>
			[...runtime.objects.keys()].filter((key) => key.startsWith(prefix)),
		listVersions: async (key: string) =>
			runtime.objects.has(key) ? ["fixture-version"] : [],
		listAtPublicOrigin: async (key: string) =>
			runtime.objects.has(key) ? [{ key }] : [],
		headPublicOrigin: async (key: string) => runtime.objects.has(key),
	}),
	refreshOriginReadPolicy: runtime.refreshPolicy,
	reconcileOriginReadPolicy: vi.fn(async () => true),
}));
vi.mock("@/lib/revision-publication-origin", async (original) => ({
	...(await original<typeof import("@/lib/revision-publication-origin")>()),
	prepareSourceOnEditorOpen: runtime.prepare,
	requestSourcePeaks: (input: {
		videoId: string;
		sourceKey: string;
		sourceSha256: string;
	}) => runtime.requestPeaks(input),
}));
vi.mock("@/lib/waveform-peaks-store", async () => {
	const { PEAKS_MAX_OBJECT_BYTES, peaksObjectKey } = await import(
		"@/lib/waveform-peaks"
	);
	return {
		putPeaksObject: async (
			videoId: string,
			sourceSha256: string,
			bytes: Uint8Array,
		) => {
			const key = peaksObjectKey(videoId, sourceSha256);
			if (!key || bytes.byteLength > PEAKS_MAX_OBJECT_BYTES) {
				throw new Error("peaks object refused");
			}
			runtime.objects.set(key, Buffer.from(bytes));
		},
		headPeaksObject: async () => null,
		readPeaksObject: async (key: string) => runtime.objects.get(key) ?? null,
	};
});
vi.mock("@/lib/revision-publication", async (original) => ({
	...(await original<typeof import("@/lib/revision-publication")>()),
	publishInstantFinishRevision: runtime.publish,
}));

const url = process.env.CAP_SOURCE_PREPARE_WORKER_MYSQL;
if (url) {
	const target = new URL(url);
	if (
		target.hostname !== "127.0.0.1" ||
		target.pathname !== "/cap57_test_worker"
	) {
		throw new Error(
			"worker fixture requires explicitly isolated cap57_test_worker on loopback",
		);
	}
}
function peaksRegressionUrl() {
	const raw = process.env.CAP_SOURCE_PREPARE_MYSQL;
	if (!raw) return undefined;
	try {
		const target = new URL(raw);
		if (
			target.hostname === "127.0.0.1" &&
			target.pathname === "/cap57_test_regression"
		) {
			return raw;
		}
	} catch {
		return undefined;
	}
	return undefined;
}
const peaksDurationDatabase = peaksRegressionUrl();
if (
	process.env.CAP_SOURCE_PREPARE_REQUIRE_REGRESSION === "1" &&
	!peaksDurationDatabase
) {
	throw new Error(
		"peaks duration fixture requires loopback cap57_test_regression",
	);
}
const ownerId = User.UserId.make("u57parent00001");
const videoId = Video.VideoId.make("v57parent00001");
const oldKey = `${ownerId}/${videoId}/result.mp4`;
const source = Buffer.from("immutable parent source bytes");
const sha = createHash("sha256").update(source).digest("hex");
const revisionId = "parent57baseline";
const boundSourceId = sourceIdFromIdentity({
	key: `private/source/${videoId}/${sha}`,
	sha256: sha,
	codec: "h264",
	timebase: "1/90000",
	frameMode: "cfr",
});
let captionBody = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nkeep\n";
let pool: Pool;
let database: MySql2Database<Record<string, unknown>>;
const tables = [
	schema.videos,
	schema.sourceObject,
	schema.sourceRelocation,
	schema.videoEdits,
	schema.videoPublication,
	schema.editIntent,
	schema.editRevision,
	schema.revisionArtifactStatus,
	schema.revisionOutbox,
	schema.comments,
];

async function expectCoreAndPeaksJobs(coreCount: number) {
	const rows = await database.select().from(schema.revisionOutbox);
	const isPeaks = (row: (typeof rows)[number]) =>
		(row.payload as { peaksOnly?: boolean }).peaksOnly === true;
	const peaks = rows.filter(isPeaks);
	expect(rows.filter((row) => !isPeaks(row))).toHaveLength(coreCount);
	expect(peaks).toHaveLength(1);
	const [registered] = await database.select().from(schema.sourceObject);
	if (!registered) throw new Error("registered peaks fixture missing");
	expect(peaks[0]).toMatchObject({
		videoId,
		revisionId: "srcprep",
		job: "source-prepare",
		payload: {
			videoId,
			ownerId,
			phase: "peaks",
			peaksOnly: true,
			sha256: registered.sha256,
			sourceObjectKey: registered.liveKey,
			stableKey: registered.liveKey,
		},
	});
}

async function setJob(overrides: Record<string, unknown> = {}) {
	await database.delete(schema.revisionOutbox);
	await database.insert(schema.revisionOutbox).values({
		videoId,
		revisionId: "source-prepare",
		job: "source-prepare",
		createdAt: new Date(),
		payload: {
			videoId,
			ownerId,
			sourceObjectKey: oldKey,
			stableKey: `private/source/${videoId}/original`,
			attempts: 0,
			notBeforeMs: 0,
			...overrides,
		},
	});
}
const origin = {
	writeCaptions: vi.fn(async (input: { captionsVtt: string }) => {
		captionBody = input.captionsVtt;
		return { sha256: createHash("sha256").update(captionBody).digest("hex") };
	}),
	prepareRevision: vi.fn(async () => {
		throw new Error("worker must not encode a revision for captions");
	}),
	selectFrames: vi.fn(async () => {
		throw new Error("worker must not select frames for captions");
	}),
	fetchArtifact: vi.fn(async ({ name }: { name: string }) => ({
		status: 200,
		body: Buffer.from(
			name === "captions.vtt"
				? captionBody
				: name === "playlist.m3u8"
					? "#EXTM3U\n#EXTINF:20.0,\nseg/0.m4s\n"
					: "media",
		),
		contentType: name === "captions.vtt" ? "text/vtt" : "video/mp4",
	})),
};

async function seedCurrent() {
	expect(isUntouchedEditorSpec(untouchedEditorSpec(20))).toBe(true);
	await database
		.insert(schema.sourceObject)
		.values({
			videoId,
			liveKey: `private/source/${videoId}/${sha}`,
			sha256: sha,
			codec: "h264",
			timebase: "1/90000",
			frameMode: "cfr",
			relocationState: "PURGED",
			a1Digest: sha,
			indexId: "bound-index",
			warmExpiresAt: new Date(Date.now() - 60_000),
		})
		.onDuplicateKeyUpdate({
			set: {
				liveKey: `private/source/${videoId}/${sha}`,
				relocationState: "PURGED",
			},
		});
	runtime.objects.set(`private/source/${videoId}/${sha}`, source);
	runtime.objects.delete(oldKey);
	await database.insert(schema.sourceRelocation).values({
		videoId,
		revisionId: "source",
		oldKey,
		newKey: `private/source/${videoId}/${sha}`,
		sha256: sha,
		state: "PURGED",
		createdAt: new Date(),
	});
	await database.update(schema.videoPublication).set({
		currentRevisionId: revisionId,
		currentGeneration: 1,
		generation: 1,
		publicationEpoch: 1,
	});
	await database.insert(schema.editIntent).values({
		intentId: "parent57identity",
		videoId,
		sourceId: boundSourceId,
		generation: 1,
		draftVersion: 0,
		canonicalSpec: untouchedEditorSpec(20),
		mappingVersion: 1,
		encoderProfile: ENCODER_PROFILE,
		draftSession: "source-prepare",
		createdAt: new Date(),
	});
	await database.insert(schema.editRevision).values({
		revisionId,
		videoId,
		intentId: "parent57identity",
		sourceId: boundSourceId,
		generation: 1,
		state: "CURRENT",
		attempt: 1,
		createdAt: new Date(),
		updatedAt: new Date(),
		metadataSnapshot: {
			captionsVtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nkeep\n",
			chapters: [],
			summaryStatus: "persisted",
			summaryDerived: false,
			summaryText: null,
			thumbnail: "unavailable",
			durationSeconds: 20,
		},
	});
}

describe.skipIf(!url)("durable source worker on an isolated real MySQL", () => {
	beforeAll(async () => {
		vi.stubEnv("CAP_INSTANT_FINISH_OWNERS", ownerId);
		pool = createPool(url!);
		database = drizzle(pool);
		for (const table of tables) {
			const config = getTableConfig(table);
			const columns = config.columns.map(
				(column) =>
					`\`${column.name}\` ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}${column.columnType === "MySqlInt" && "autoIncrement" in column && column.autoIncrement ? " AUTO_INCREMENT" : ""}`,
			);
			if (config.primaryKeys.length)
				columns.push(
					`PRIMARY KEY (${config.primaryKeys[0]!.columns.map((column) => `\`${column.name}\``).join(",")})`,
				);
			await pool.query(
				`CREATE TABLE IF NOT EXISTS \`${config.name}\` (${columns.join(",")})`,
			);
		}
	});
	beforeEach(async () => {
		for (const table of [...tables].reverse())
			await pool.query(`DELETE FROM \`${getTableName(table)}\``);
		runtime.objects.clear();
		runtime.objects.set(oldKey, source);
		runtime.prepare.mockReset();
		runtime.publish.mockReset();
		runtime.refreshPolicy.mockClear();
		runtime.deletes = [];
		runtime.deleteThrows = 0;
		runtime.peaksExistsThrows = false;
		origin.writeCaptions.mockClear();
		origin.prepareRevision.mockClear();
		captionBody = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nkeep\n";
		finishInventoryProbe.getObject = async () => null;
		await database.insert(schema.videos).values({
			id: videoId,
			ownerId,
			orgId: Organisation.OrganisationId.make("o57parent00001"),
			name: "worker fixture",
			source: { type: "desktopMP4" },
			duration: 20,
		});
		await database.insert(schema.videoPublication).values({
			videoId,
			currentRevisionId: null,
			currentGeneration: null,
			generation: 0,
			latestDraftVersion: 0,
			draftSession: "",
			publicationEpoch: 0,
			policyEpoch: 0,
		});
		runtime.prepare.mockImplementation(
			async ({ sourceKey }: { sourceKey: string }) => ({
				sourceKey,
				sha256: sha,
				codec: "h264",
				timebase: "1/90000",
				frameMode: "cfr",
				durationSeconds: 20,
				sourceSha256: sha,
				a1Digest: sha,
				indexId: "bound-index",
				warmExpiresAt: new Date(Date.now() + 600_000).toISOString(),
			}),
		);
		runtime.publish.mockImplementation(async () => {
			await seedCurrent();
			return { kind: "published", revisionId };
		});
		await setJob();
	});
	afterAll(async () => {
		vi.unstubAllEnvs();
		delete finishInventoryProbe.getObject;
		delete finishInventoryProbe.listPrefix;
		if (pool) await pool.end();
	});

	it.each(["warm", "cold"] as const)(
		"continues %s core preparation when only the optional peaks probe fails",
		async (state) => {
			await seedCurrent();
			if (state === "cold") {
				await database.delete(schema.editRevision);
				await database.delete(schema.editIntent);
				await database.update(schema.sourceObject).set({
					a1Digest: null,
					indexId: null,
					warmExpiresAt: null,
				});
				await database.update(schema.videoPublication).set({
					currentRevisionId: null,
					currentGeneration: null,
				});
			}
			const rawKey = `${ownerId}/${videoId}/raw-upload.mp4`;
			runtime.objects.set(rawKey, Buffer.from("leftover fixture"));
			runtime.peaksExistsThrows = true;
			const { drainSourcePrepare } = await import(
				"@/lib/source-prepare-worker"
			);
			await drainSourcePrepare(database as never, origin as never);
			await expectCoreAndPeaksJobs(0);
			expect(runtime.objects.has(rawKey)).toBe(false);
			expect(runtime.prepare).toHaveBeenCalledTimes(state === "cold" ? 1 : 0);
			expect(runtime.publish).toHaveBeenCalledTimes(state === "cold" ? 1 : 0);
			const [registered] = await database.select().from(schema.sourceObject);
			expect(registered).toMatchObject({
				sha256: sha,
				liveKey: `private/source/${videoId}/${sha}`,
				relocationState: "PURGED",
			});
			expect(runtime.objects.get(registered?.liveKey ?? "")).toEqual(source);
			expect(
				(await database.select().from(schema.videoPublication))[0],
			).toMatchObject({ currentRevisionId: revisionId });
			expect(origin.prepareRevision).not.toHaveBeenCalled();
		},
	);

	it("clears full inventory on a warm PURGED identity without native preparation", async () => {
		await seedCurrent();
		await database.update(schema.sourceObject).set({
			warmExpiresAt: new Date(Date.now() + 600_000),
		});
		const prefix = `${ownerId}/${videoId}/`;
		const leftovers = [
			"raw-upload.webm",
			"screenshot/screen-capture.jpg",
			"preview/animated-preview.gif",
		];
		const retained = ["transcription.vtt", "comments/attachment.png"];
		for (const suffix of [...leftovers, ...retained])
			runtime.objects.set(prefix + suffix, Buffer.from(suffix));
		const otherKey = `${ownerId}/v57parent00002/raw-upload.mp4`;
		runtime.objects.set(otherKey, Buffer.from("other video"));
		const beforeSource = (await database.select().from(schema.sourceObject))[0];
		const beforeCurrent = (
			await database.select().from(schema.videoPublication)
		)[0];
		if (!beforeSource || !beforeCurrent)
			throw new Error("warm fixture missing");
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		for (const suffix of leftovers)
			expect(runtime.objects.has(prefix + suffix)).toBe(false);
		for (const suffix of retained)
			expect(runtime.objects.get(prefix + suffix)).toEqual(Buffer.from(suffix));
		expect(runtime.objects.get(otherKey)).toEqual(Buffer.from("other video"));
		expect((await database.select().from(schema.sourceObject))[0]).toEqual(
			beforeSource,
		);
		expect((await database.select().from(schema.videoPublication))[0]).toEqual(
			beforeCurrent,
		);
		expect(runtime.objects.get(beforeSource.liveKey)).toEqual(source);
		await expectCoreAndPeaksJobs(0);
		expect(runtime.prepare).not.toHaveBeenCalled();
		expect(runtime.publish).not.toHaveBeenCalled();
		expect(origin.prepareRevision).not.toHaveBeenCalled();
	});

	it("retries interrupted rollback cleanup after the original is already PURGED", async () => {
		await seedCurrent();
		await database.update(schema.sourceObject).set({
			warmExpiresAt: new Date(Date.now() + 600_000),
		});
		const rawKey = `${ownerId}/${videoId}/raw-upload.mp4`;
		runtime.objects.set(rawKey, Buffer.from("raw bytes"));
		runtime.deleteThrows = 1;
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		expect(await database.select().from(schema.revisionOutbox)).toHaveLength(1);
		expect(runtime.objects.has(rawKey)).toBe(true);
		const [pending] = await database.select().from(schema.revisionOutbox);
		if (!pending) throw new Error("retry job missing");
		await database.update(schema.revisionOutbox).set({
			payload: {
				...(pending.payload as object),
				notBeforeMs: 0,
				leaseUntilMs: 0,
			},
		});
		await drainSourcePrepare(database as never, origin as never);
		expect(runtime.objects.has(rawKey)).toBe(false);
		await expectCoreAndPeaksJobs(0);
		const rows = await database.select().from(schema.sourceRelocation);
		expect(rows.filter((row) => row.oldKey === rawKey)).toHaveLength(1);
		expect(rows.every((row) => row.state === "PURGED")).toBe(true);
		expect(runtime.prepare).not.toHaveBeenCalled();
		expect(runtime.publish).not.toHaveBeenCalled();
	});

	it("keeps the existing Finish fence closed for terminal ABORTED history", async () => {
		await seedCurrent();
		await database.update(schema.sourceObject).set({
			warmExpiresAt: new Date(Date.now() + 600_000),
		});
		await database.insert(schema.sourceRelocation).values({
			videoId,
			revisionId: "failed-copy",
			oldKey: `${ownerId}/${videoId}/old-preview.gif`,
			newKey: `private/rollback/${videoId}/failed-copy`,
			sha256: sha,
			state: "ABORTED",
			createdAt: new Date(),
		});
		const { allocateRevision } = await import("@/lib/revision-publication");
		const cut = {
			...untouchedEditorSpec(20),
			manualKeepRanges: [{ start: 0, end: 10 }],
			keepRanges: [{ start: 0, end: 10 }],
		};
		await expect(
			database.transaction((tx) =>
				allocateRevision(
					tx as never,
					{
						videoId,
						editSpec: cut,
						baseGeneration: 1,
						draftVersion: 1,
						draftSession: "aborted-history",
						sourceDuration: 20,
					},
					cut,
					new Date(),
					() => "blocked-history",
				),
			),
		).rejects.toMatchObject({
			status: 409,
			message:
				"Finish refused until source relocation is PURGED and liveKey is the relocated key",
		});
		const rawKey = `${ownerId}/${videoId}/raw-upload.mp4`;
		runtime.objects.set(rawKey, Buffer.from("retained during refusal"));
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		expect(runtime.objects.has(rawKey)).toBe(true);
		expect(await database.select().from(schema.revisionOutbox)).toHaveLength(1);
		expect(runtime.prepare).not.toHaveBeenCalled();
		expect(runtime.publish).not.toHaveBeenCalled();
	});

	it("registers a verified COPIED row before native preparation, without flipping CURRENT", async () => {
		runtime.prepare.mockImplementationOnce(
			async ({ sourceKey: key }: { sourceKey: string }) => {
				const registered = await database.select().from(schema.sourceObject);
				const staged = await database.select().from(schema.sourceRelocation);
				expect.soft(registered).toHaveLength(1);
				expect(registered[0]?.liveKey).toBe(oldKey);
				expect(registered[0]?.sha256).toBe(sha);
				expect(staged).toHaveLength(1);
				expect(staged[0]?.newKey).toBe(key);
				expect(staged[0]?.sha256).toBe(sha);
				expect(staged[0]?.state).toBe("COPIED");
				expect(
					(await database.select().from(schema.videoPublication))[0]
						?.currentRevisionId,
				).toBeNull();
				throw new Error("stop after admission proof");
			},
		);
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		expect(runtime.prepare).toHaveBeenCalledTimes(1);
		expect(await database.select().from(schema.sourceRelocation)).toHaveLength(
			1,
		);
		expect(runtime.publish).not.toHaveBeenCalled();
	});

	it("after a private COPIED crash, resumes that row instead of creating a second unregistered copy", async () => {
		const key = `private/source/${videoId}/${sha}`;
		runtime.objects.set(key, source);
		await database.insert(schema.sourceObject).values({
			videoId,
			liveKey: oldKey,
			sha256: sha,
			relocationState: "LIVE",
		});
		await database.insert(schema.sourceRelocation).values({
			videoId,
			revisionId: "source",
			oldKey,
			newKey: key,
			sha256: sha,
			state: "COPIED",
			createdAt: new Date(),
		});
		runtime.prepare.mockImplementationOnce(
			async ({ sourceKey: preparedKey }: { sourceKey: string }) => {
				expect.soft(preparedKey).toBe(key);
				throw new Error("stop after resumed admission");
			},
		);
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		expect(runtime.prepare).toHaveBeenCalledTimes(1);
		expect(await database.select().from(schema.sourceRelocation)).toHaveLength(
			1,
		);
	});

	async function waitingCaptions() {
		await seedCurrent();
		const [revision] = await database.select().from(schema.editRevision);
		await database.update(schema.editRevision).set({
			metadataSnapshot: {
				...revision!.metadataSnapshot!,
				captionsVtt: "WEBVTT\n",
			},
		});
		await database
			.update(schema.videos)
			.set({ transcriptionStatus: "COMPLETE" });
		captionBody = "WEBVTT\n";
		await setJob({ phase: "captions" });
	}
	function encryptedWords(owner = ownerId, id = videoId, durationMs = 20_000) {
		return encryptEditTranscriptObject(
			JSON.stringify({
				version: EDIT_TRANSCRIPT_VERSION,
				speechModelUsed: "synthetic-parent-fixture",
				durationMs,
				languageCode: "en",
				words: [
					{
						id: "w1",
						text: "genuine fixture words",
						startMs: 0,
						endMs: 1000,
						confidence: 1,
						speaker: null,
						channel: null,
					},
				],
			}),
			owner,
			id,
		);
	}

	it("late COMPLETE reloads the actual encrypted words and changes only the matching caption field", async () => {
		await waitingCaptions();
		finishInventoryProbe.getObject = async () => encryptedWords();
		const before = (await database.select().from(schema.videoPublication))[0];
		const beforeSnapshot = (
			await database.select().from(schema.editRevision)
		)[0]!.metadataSnapshot!;
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		await expectCoreAndPeaksJobs(0);
		expect(origin.writeCaptions).toHaveBeenCalledTimes(1);
		expect(captionBody).toContain("genuine fixture words");
		expect(captionBody).toContain("-->");
		const afterSnapshot = (
			await database.select().from(schema.editRevision)
		)[0]!.metadataSnapshot!;
		expect(afterSnapshot.captionsVtt).toBe(captionBody);
		expect({
			...afterSnapshot,
			captionsVtt: beforeSnapshot.captionsVtt,
		}).toEqual(beforeSnapshot);
		expect((await database.select().from(schema.videoPublication))[0]).toEqual(
			before,
		);
		expect(runtime.prepare).not.toHaveBeenCalled();
		expect(runtime.publish).not.toHaveBeenCalled();
		expect(origin.prepareRevision).not.toHaveBeenCalled();
	});

	it.each(["missing", "wrong-owner", "wrong-duration"])(
		"COMPLETE with %s words remains pending, never READY or media preparation",
		async (kind) => {
			await waitingCaptions();
			finishInventoryProbe.getObject = async () =>
				kind === "missing"
					? null
					: kind === "wrong-owner"
						? encryptedWords(User.UserId.make("otherowner0001"))
						: encryptedWords(ownerId, videoId, 30_000);
			const { drainSourcePrepare } = await import(
				"@/lib/source-prepare-worker"
			);
			await drainSourcePrepare(database as never, origin as never);
			await expectCoreAndPeaksJobs(1);
			expect(
				(await database.select().from(schema.editRevision))[0]!
					.metadataSnapshot!.captionsVtt,
			).toBe("WEBVTT\n");
			expect(origin.writeCaptions).not.toHaveBeenCalled();
			expect(origin.prepareRevision).not.toHaveBeenCalled();
			expect(
				(await database.select().from(schema.revisionArtifactStatus)).some(
					(row) => row.artifact === "captions" && row.state === "READY",
				),
			).toBe(false);
		},
	);

	it("late words map through the actual CURRENT cut without resurrecting removed speech", async () => {
		await waitingCaptions();
		const spec = {
			...untouchedEditorSpec(20),
			manualKeepRanges: [
				{ start: 0, end: 1 },
				{ start: 3, end: 20 },
			],
			keepRanges: [
				{ start: 0, end: 1 },
				{ start: 3, end: 20 },
			],
		};
		await database.update(schema.editIntent).set({ canonicalSpec: spec });
		const raw = {
			version: EDIT_TRANSCRIPT_VERSION,
			speechModelUsed: "synthetic-parent-fixture",
			durationMs: 20_000,
			languageCode: "en",
			words: [
				{
					id: "w1",
					text: "kept",
					startMs: 0,
					endMs: 500,
					confidence: 1,
					speaker: null,
					channel: null,
				},
				{
					id: "w2",
					text: "removed-secret",
					startMs: 2000,
					endMs: 2500,
					confidence: 1,
					speaker: null,
					channel: null,
				},
				{
					id: "w3",
					text: "kept-later",
					startMs: 4000,
					endMs: 4500,
					confidence: 1,
					speaker: null,
					channel: null,
				},
			],
		};
		finishInventoryProbe.getObject = async () =>
			encryptEditTranscriptObject(JSON.stringify(raw), ownerId, videoId);
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		expect(origin.writeCaptions).toHaveBeenCalledTimes(1);
		expect(captionBody).toContain("kept-later");
		expect(captionBody).not.toContain("removed-secret");
		expect(origin.prepareRevision).not.toHaveBeenCalled();
		expect(runtime.publish).not.toHaveBeenCalled();
	});

	it("a CURRENT race during side-write cannot mark a different revision READY", async () => {
		await waitingCaptions();
		finishInventoryProbe.getObject = async () => encryptedWords();
		origin.writeCaptions.mockImplementationOnce(async (input) => {
			captionBody = input.captionsVtt;
			await database.update(schema.videoPublication).set({
				currentRevisionId: "racing-cut",
				currentGeneration: 2,
				publicationEpoch: 2,
			});
			return { sha256: createHash("sha256").update(captionBody).digest("hex") };
		});
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		expect(
			(await database.select().from(schema.videoPublication))[0]
				?.currentRevisionId,
		).toBe("racing-cut");
		expect(
			(await database.select().from(schema.editRevision))[0]!.metadataSnapshot!
				.captionsVtt,
		).toBe("WEBVTT\n");
		expect(
			(await database.select().from(schema.revisionArtifactStatus)).some(
				(row) => row.state === "READY",
			),
		).toBe(false);
		expect(origin.prepareRevision).not.toHaveBeenCalled();
	});

	it("missing words reach a bounded unavailable outcome instead of polling forever", async () => {
		await seedCurrent();
		await database
			.update(schema.videos)
			.set({ transcriptionStatus: "COMPLETE" });
		await database.update(schema.editRevision).set({
			metadataSnapshot: {
				captionsVtt: "WEBVTT\n",
				chapters: [],
				summaryStatus: "persisted",
				summaryDerived: false,
				summaryText: null,
				thumbnail: "unavailable",
				durationSeconds: 20,
			},
		});
		await setJob({ phase: "captions", captionDeadlineMs: Date.now() - 60_000 });
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		const row = (await database.select().from(schema.revisionOutbox))[0]!;
		expect(row.payload).toMatchObject({ exhausted: true, finished: false });
		expect(origin.writeCaptions).not.toHaveBeenCalled();
	});

	it("word completion durably wakes caption work without any browser request", async () => {
		await seedCurrent();
		await database.delete(schema.revisionOutbox);
		const worker = await import("@/lib/source-prepare-worker");
		await worker.enqueueSourceCaptionsAfterTranscript(database, videoId);
		const rows = await database.select().from(schema.revisionOutbox);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.job).toBe("source-prepare");
		await database.transaction(async (tx) =>
			worker.enqueueSourceCaptionsAfterTranscript(tx, videoId),
		);
		expect(await database.select().from(schema.revisionOutbox)).toHaveLength(1);
	});

	async function retainedWithCut() {
		await seedCurrent();
		await database.update(schema.editRevision).set({ state: "SUPERSEDED" });
		const spec = {
			...untouchedEditorSpec(20),
			manualKeepRanges: [{ start: 0, end: 10 }],
			keepRanges: [{ start: 0, end: 10 }],
		};
		await database.insert(schema.editIntent).values({
			videoId,
			generation: 2,
			intentId: "parentcut",
			sourceId: boundSourceId,
			canonicalSpec: spec,
			mappingVersion: 1,
			encoderProfile: ENCODER_PROFILE,
			draftVersion: 1,
			draftSession: "owner-session",
			createdAt: new Date(),
		});
		await database.insert(schema.editRevision).values({
			videoId,
			generation: 2,
			intentId: "parentcut",
			sourceId: boundSourceId,
			revisionId: "parentcut",
			state: "CURRENT",
			attempt: 1,
			metadataSnapshot: {
				captionsVtt: "WEBVTT\n",
				chapters: [],
				summaryStatus: "persisted",
				summaryDerived: false,
				summaryText: "old cut summary",
				thumbnail: "unavailable",
				durationSeconds: 10,
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		await database.update(schema.videoPublication).set({
			currentRevisionId: "parentcut",
			currentGeneration: 2,
			generation: 3,
			publicationEpoch: 2,
			policyEpoch: 2,
		});
		await database.insert(schema.editRevision).values({
			videoId,
			generation: 3,
			intentId: "inflightcut",
			sourceId: boundSourceId,
			revisionId: "inflightcut",
			state: "PUBLISHING",
			attempt: 1,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		await database.update(schema.videos).set({
			metadata: {
				summary: "latest owner summary",
				sourceChapters: [],
				chapters: [{ title: "must not resurrect", start: 0 }],
				chaptersRevisionId: "parentcut",
			},
		});
	}

	it("Restore Done requires native readable retained media and does not point to a missing artifact", async () => {
		await retainedWithCut();
		const before = (await database.select().from(schema.videoPublication))[0];
		const { restoreRetainedIdentity } = await import(
			"@/lib/revision-publication"
		);
		const refusedOrigin = {
			...origin,
			fetchArtifact: vi.fn(async () => ({
				status: 404,
				body: Buffer.alloc(0),
				contentType: null,
			})),
		};
		await expect(
			restoreRetainedIdentity(database, videoId, {
				origin: refusedOrigin,
				nextSpec: { ...untouchedEditorSpec(20), autoCutsInitialized: true },
			}),
		).rejects.toThrow(/retained|readable|available/i);
		expect((await database.select().from(schema.videoPublication))[0]).toEqual(
			before,
		);
	});

	it("retarget preserves artifact generation, fences an in-flight cut, and preserves owner chapter deletion", async () => {
		await retainedWithCut();
		const before = (await database.select().from(schema.editRevision)).find(
			(row) => row.revisionId === revisionId,
		)!.metadataSnapshot;
		const { restoreRetainedIdentity } = await import(
			"@/lib/revision-publication"
		);
		const restored = await restoreRetainedIdentity(database, videoId, {
			origin,
			nextSpec: { ...untouchedEditorSpec(20), autoCutsInitialized: true },
			baseGeneration: 2,
		});
		expect(restored).toEqual({ revisionId, generation: 4 });
		const publication = (
			await database.select().from(schema.videoPublication)
		)[0]!;
		expect(publication.currentGeneration).toBe(1);
		expect(publication.generation).toBe(4);
		expect(publication.policyEpoch).toBe(3);
		expect(publication.publicationEpoch).toBe(3);
		const revisions = await database.select().from(schema.editRevision);
		expect(revisions.find((row) => row.revisionId === revisionId)?.state).toBe(
			"CURRENT",
		);
		expect(
			revisions.find((row) => row.revisionId === "inflightcut")?.state,
		).toBe("SUPERSEDED");
		expect(revisions.find((row) => row.revisionId === "parentcut")?.state).toBe(
			"SUPERSEDED",
		);
		expect(
			revisions.find((row) => row.revisionId === revisionId)?.metadataSnapshot,
		).toEqual(before);
		const metadata = (await database.select().from(schema.videos))[0]!
			.metadata!;
		expect(metadata.summary).toBe("latest owner summary");
		expect(metadata.sourceChapters).toEqual([]);
		expect(metadata.chapters).toEqual([]);
		expect(origin.prepareRevision).not.toHaveBeenCalled();
		const { getInstantFinishPublicationDto } = await import(
			"@/lib/revision-publication-read"
		);
		const dto = await getInstantFinishPublicationDto({
			videoId,
			ownerId,
			database,
		});
		expect(dto.generation).toBe(4);
		expect(dto.revisionMetadata.summaryText).toBe("latest owner summary");
	});

	it("existing readable identity finishes a captions retry even with expired warm source fields", async () => {
		await seedCurrent();
		await setJob({ phase: "captions" });
		expect(
			isUntouchedEditorSpec(
				(await database.select().from(schema.editIntent))[0]?.canonicalSpec,
			),
		).toBe(true);
		const before = (await database.select().from(schema.videoPublication))[0];
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		await expectCoreAndPeaksJobs(0);
		expect(runtime.prepare).not.toHaveBeenCalled();
		expect(runtime.publish).not.toHaveBeenCalled();
		expect((await database.select().from(schema.videoPublication))[0]).toEqual(
			before,
		);
	});

	const privateKey = `private/source/${videoId}/${sha}`;

	async function seedAfterPointer(
		input: { cut?: boolean; readable?: boolean; purged?: boolean } = {},
	) {
		const readable = input.readable !== false;
		runtime.objects.set(oldKey, source);
		runtime.objects.set(privateKey, source);
		await database.insert(schema.sourceObject).values({
			videoId,
			liveKey: privateKey,
			sha256: sha,
			relocationState: input.purged ? "PURGED" : "COPIED",
			codec: "h264",
			timebase: "1/90000",
			frameMode: "cfr",
			a1Digest: sha,
			indexId: "bound-index",
			warmExpiresAt: new Date(Date.now() + 600_000),
		});
		await database.insert(schema.sourceRelocation).values({
			videoId,
			revisionId: "source",
			oldKey,
			newKey: privateKey,
			sha256: sha,
			state: input.purged ? "PURGED" : "POINTER",
			createdAt: new Date(),
		});
		const spec = input.cut
			? {
					...untouchedEditorSpec(20),
					manualKeepRanges: [{ start: 0, end: 10 }],
					keepRanges: [{ start: 0, end: 10 }],
				}
			: untouchedEditorSpec(20);
		await database.insert(schema.editIntent).values({
			intentId: "parent57identity",
			videoId,
			sourceId: boundSourceId,
			generation: 1,
			draftVersion: 0,
			canonicalSpec: spec,
			mappingVersion: 1,
			encoderProfile: ENCODER_PROFILE,
			draftSession: "source-prepare",
			createdAt: new Date(),
		});
		await database.insert(schema.editRevision).values({
			revisionId,
			videoId,
			intentId: "parent57identity",
			sourceId: boundSourceId,
			generation: 1,
			state: "CURRENT",
			attempt: 1,
			createdAt: new Date(),
			updatedAt: new Date(),
			metadataSnapshot: {
				captionsVtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nkeep\n",
				chapters: [],
				summaryStatus: "persisted",
				summaryDerived: false,
				summaryText: null,
				thumbnail: "unavailable",
				durationSeconds: 20,
			},
		});
		await database.update(schema.videoPublication).set({
			currentRevisionId: revisionId,
			currentGeneration: 1,
			generation: 1,
			publicationEpoch: 1,
		});
		if (!readable) {
			origin.fetchArtifact.mockImplementation(async () => ({
				status: 404,
				body: Buffer.alloc(0),
				contentType: "application/octet-stream",
			}));
		}
		await setJob();
	}

	it("resumes after_pointer deletion, keeps one private copy, and retries a single delete failure", async () => {
		await seedAfterPointer();
		runtime.deleteThrows = 1;
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		expect(await database.select().from(schema.revisionOutbox)).toHaveLength(1);
		expect(runtime.objects.has(oldKey)).toBe(true);
		expect(runtime.objects.has(privateKey)).toBe(true);
		expect(
			(await database.select().from(schema.videoPublication))[0]
				?.currentRevisionId,
		).toBe(revisionId);
		const [held] = await database.select().from(schema.revisionOutbox);
		await database.update(schema.revisionOutbox).set({
			payload: {
				...(held?.payload as object),
				notBeforeMs: 0,
				leaseUntilMs: 0,
			},
		});
		await drainSourcePrepare(database as never, origin as never);
		expect(runtime.objects.has(oldKey)).toBe(false);
		expect(runtime.objects.has(privateKey)).toBe(true);
		expect(runtime.deletes.filter((key) => key === oldKey)).toHaveLength(1);
		expect(
			(await database.select().from(schema.sourceRelocation))[0]?.state,
		).toBe("PURGED");
		expect(
			(await database.select().from(schema.videoPublication))[0]
				?.currentRevisionId,
		).toBe(revisionId);
	});

	it("resumes deletion for a readable cut and refuses an unreadable current", async () => {
		await seedAfterPointer({ cut: true });
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		expect(runtime.objects.has(oldKey)).toBe(false);
		expect(runtime.objects.has(privateKey)).toBe(true);
		expect(
			(await database.select().from(schema.videoPublication))[0]
				?.currentRevisionId,
		).toBe(revisionId);
		await database.delete(schema.sourceObject);
		await database.delete(schema.sourceRelocation);
		await database.delete(schema.editIntent);
		await database.delete(schema.editRevision);
		runtime.deletes = [];
		await seedAfterPointer({ readable: false });
		await drainSourcePrepare(database as never, origin as never);
		expect(runtime.deletes).toEqual([]);
		expect(runtime.objects.has(oldKey)).toBe(true);
		expect(await database.select().from(schema.revisionOutbox)).toHaveLength(1);
	});

	it("completes leftover inventory while purged captions are still pending", async () => {
		await seedAfterPointer({ purged: true });
		runtime.objects.delete(oldKey);
		const screenshot = `${ownerId}/${videoId}/screenshot/screen-capture.jpg`;
		const preview = `${ownerId}/${videoId}/preview/animated-preview.gif`;
		const audio = `private/source/${videoId}/audio-temp.mp3`;
		for (const key of [screenshot, preview, audio])
			runtime.objects.set(key, source);
		await database
			.update(schema.videos)
			.set({ transcriptionStatus: "COMPLETE" });
		const [revision] = await database.select().from(schema.editRevision);
		await database.update(schema.editRevision).set({
			metadataSnapshot: {
				...revision!.metadataSnapshot!,
				captionsVtt: "WEBVTT\n",
			},
		});
		captionBody = "WEBVTT\n";
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		expect(runtime.deletes.sort()).toEqual([screenshot, preview].sort());
		expect(runtime.objects.has(screenshot)).toBe(false);
		expect(runtime.objects.has(preview)).toBe(false);
		expect(runtime.objects.has(privateKey)).toBe(true);
		expect(runtime.objects.has(audio)).toBe(true);
		await expectCoreAndPeaksJobs(1);
	});

	it("prepares a copied key when the public row is already warm and does not encode a warm purge", async () => {
		const journalKey = `private/source/${videoId}/not-stable`;
		runtime.objects.set(journalKey, source);
		await database.insert(schema.sourceObject).values({
			videoId,
			liveKey: oldKey,
			sha256: sha,
			relocationState: "LIVE",
			codec: "h264",
			timebase: "1/90000",
			frameMode: "cfr",
			a1Digest: sha,
			indexId: "bound-index",
			warmExpiresAt: new Date(Date.now() + 600_000),
		});
		await database.insert(schema.sourceRelocation).values({
			videoId,
			revisionId: "source",
			oldKey,
			newKey: journalKey,
			sha256: sha,
			state: "COPIED",
			createdAt: new Date(),
		});
		const published: string[] = [];
		runtime.prepare.mockImplementation(
			async ({ sourceKey }: { sourceKey: string }) => ({
				sourceKey,
				sha256: sha,
				codec: "h264",
				timebase: "1/90000",
				frameMode: "cfr",
				durationSeconds: 20,
				sourceSha256: sha,
				a1Digest: sha,
				indexId: "bound-index",
				warmExpiresAt: new Date(Date.now() + 600_000).toISOString(),
			}),
		);
		runtime.publish.mockImplementation(
			async (_app: unknown, input: { baselineIdentity?: { key?: string } }) => {
				published.push(input.baselineIdentity?.key ?? "");
				return { kind: "published", revisionId: "pub-b9" };
			},
		);
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		expect(runtime.prepare).toHaveBeenCalledTimes(1);
		expect(runtime.prepare.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({ sourceKey: journalKey }),
		);
		expect(published).toEqual([journalKey]);
		expect(
			(await database.select().from(schema.sourceObject))[0]?.liveKey,
		).toBe(oldKey);
		await database.delete(schema.sourceObject);
		await database.delete(schema.sourceRelocation);
		runtime.prepare.mockClear();
		published.length = 0;
		await database.insert(schema.sourceObject).values({
			videoId,
			liveKey: privateKey,
			sha256: sha,
			relocationState: "PURGED",
			codec: "h264",
			timebase: "1/90000",
			frameMode: "cfr",
			a1Digest: sha,
			indexId: "bound-index",
			warmExpiresAt: new Date(Date.now() + 600_000),
		});
		await database.insert(schema.sourceRelocation).values({
			videoId,
			revisionId: "source",
			oldKey,
			newKey: privateKey,
			sha256: sha,
			state: "PURGED",
			createdAt: new Date(),
		});
		await seedCurrent();
		await database.update(schema.sourceObject).set({
			warmExpiresAt: new Date(Date.now() + 600_000),
			liveKey: privateKey,
			relocationState: "PURGED",
		});
		const held = await database.select().from(schema.revisionOutbox);
		const due = held[0];
		if (!due) {
			await setJob();
		} else {
			await database.update(schema.revisionOutbox).set({
				payload: {
					...(due.payload as object),
					notBeforeMs: 0,
					leaseUntilMs: 0,
				},
			});
		}
		runtime.prepare.mockClear();
		await drainSourcePrepare(database as never, origin as never);
		expect(runtime.prepare).not.toHaveBeenCalled();
	});

	it("rewarms an expired purged source and fails closed on a mismatched identity", async () => {
		await database.insert(schema.sourceObject).values({
			videoId,
			liveKey: privateKey,
			sha256: sha,
			relocationState: "PURGED",
			codec: "h264",
			timebase: "1/90000",
			frameMode: "cfr",
			a1Digest: sha,
			indexId: "bound-index",
			warmExpiresAt: new Date(Date.now() - 60_000),
		});
		await database.insert(schema.sourceRelocation).values({
			videoId,
			revisionId: "source",
			oldKey,
			newKey: privateKey,
			sha256: sha,
			state: "PURGED",
			createdAt: new Date(),
		});
		runtime.objects.set(privateKey, source);
		runtime.prepare.mockImplementation(async () => ({
			sourceKey: privateKey,
			sha256: "f".repeat(64),
			codec: "h264",
			timebase: "1/90000",
			frameMode: "cfr",
			a1Digest: "e".repeat(64),
			indexId: "other-index",
			warmExpiresAt: new Date(Date.now() + 600_000).toISOString(),
		}));
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		expect(runtime.prepare).toHaveBeenCalledTimes(1);
		expect(runtime.prepare.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({ sourceKey: privateKey }),
		);
		expect(runtime.publish).not.toHaveBeenCalled();
		expect(await database.select().from(schema.revisionOutbox)).toHaveLength(1);
	});

	it("isolates concurrent drains across two due videos", async () => {
		const videoB = Video.VideoId.make("v57parent00002");
		const oldB = `${ownerId}/${videoB}/result.mp4`;
		runtime.objects.set(oldB, Buffer.from("other video bytes"));
		await database.insert(schema.videos).values({
			id: videoB,
			ownerId,
			orgId: Organisation.OrganisationId.make("o57parent00001"),
			name: "other fixture",
			source: { type: "desktopMP4" },
			duration: 20,
		});
		await database.insert(schema.videoPublication).values({
			videoId: videoB,
			currentRevisionId: null,
			currentGeneration: null,
			generation: 0,
			latestDraftVersion: 0,
			draftSession: "",
			publicationEpoch: 0,
			policyEpoch: 0,
		});
		await database.insert(schema.revisionOutbox).values({
			videoId: videoB,
			revisionId: "source-prepare",
			job: "source-prepare",
			createdAt: new Date(),
			payload: {
				videoId: videoB,
				ownerId,
				sourceObjectKey: oldB,
				stableKey: `private/source/${videoB}/original`,
				attempts: 0,
				notBeforeMs: 0,
			},
		});
		const seen: string[] = [];
		runtime.prepare.mockImplementation(
			async ({ sourceKey }: { sourceKey: string }) => {
				seen.push(sourceKey);
				throw new Error("stop after isolated prepare");
			},
		);
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await Promise.all([
			drainSourcePrepare(database as never, origin as never),
			drainSourcePrepare(database as never, origin as never),
		]);
		expect(seen).toHaveLength(2);
		expect(new Set(seen).size).toBe(2);
		expect(seen.some((key) => key.includes(String(videoId)))).toBe(true);
		expect(seen.some((key) => key.includes(String(videoB)))).toBe(true);
		const jobs = await database.select().from(schema.revisionOutbox);
		expect(jobs).toHaveLength(2);
		const payloads = jobs.map(
			(job) => job.payload as { videoId: string; leaseToken?: string },
		);
		expect(new Set(payloads.map((payload) => payload.videoId))).toEqual(
			new Set([videoId, videoB]),
		);
		expect(new Set(payloads.map((payload) => payload.leaseToken)).size).toBe(2);
		expect(runtime.objects.has(oldKey)).toBe(true);
		expect(runtime.objects.has(oldB)).toBe(true);
	});

	it("lets the next cut Done succeed after a reopened restore marker and still rejects stale media", async () => {
		await retainedWithCut();
		const { restoreRetainedIdentity, allocateRevision } = await import(
			"@/lib/revision-publication"
		);
		const { selectEditorBaselineSpec } = await import("@/lib/editor-baseline");
		await restoreRetainedIdentity(database, videoId, {
			origin,
			nextSpec: { ...untouchedEditorSpec(20), autoCutsInitialized: true },
			baseGeneration: 2,
		});
		await database
			.update(schema.sourceObject)
			.set({ warmExpiresAt: new Date(Date.now() + 600_000) });
		const [edit] = await database.select().from(schema.videoEdits);
		const [intent] = await database.select().from(schema.editIntent);
		const baseline = selectEditorBaselineSpec({
			instantFinish: true,
			publishedIntentSpec: intent?.canonicalSpec as never,
			legacySpec: edit?.editSpec as never,
			sourceDuration: 20,
		});
		expect(baseline).toMatchObject({ autoCutsInitialized: true });
		const publication = (
			await database.select().from(schema.videoPublication)
		)[0]!;
		finishInventoryProbe.listPrefix = async () => [];
		const cut = {
			...untouchedEditorSpec(20),
			manualKeepRanges: [{ start: 0, end: 10 }],
			keepRanges: [{ start: 0, end: 10 }],
		};
		const stale = {
			...baseline,
			sourceDuration: 19,
			keepRanges: [{ start: 0, end: 19 }],
			manualKeepRanges: [{ start: 0, end: 19 }],
		};
		await expect(
			database.transaction((tx) =>
				allocateRevision(
					tx as never,
					{
						videoId,
						editSpec: cut,
						expectedEditSpec: stale,
						baseGeneration: publication.generation,
						draftVersion: 2,
						draftSession: "stale-media",
						sourceDuration: 20,
					},
					cut,
					new Date(),
					() => "stale-cut",
				),
			),
		).rejects.toMatchObject({ status: 409 });
		const allocated = await database.transaction((tx) =>
			allocateRevision(
				tx as never,
				{
					videoId,
					editSpec: cut,
					expectedEditSpec: baseline,
					baseGeneration: publication.generation,
					draftVersion: 3,
					draftSession: "next-cut",
					sourceDuration: 20,
				},
				cut,
				new Date(),
				() => "next-cut-rev",
			),
		);
		expect(allocated.revisionId).toBe("next-cut-rev");
		const current = (await database.select().from(schema.editIntent)).find(
			(row) => row.intentId === "parent57identity",
		);
		expect(current?.canonicalSpec).not.toMatchObject({
			autoCutsInitialized: true,
		});
	});
});

const durationOwnerId = User.UserId.make("u48srcdur000001");
const durationVideoId = Video.VideoId.make("v48srcdur000001");
const durationOrgId = Organisation.OrganisationId.make("o48srcdur000001");
const durationSource = Buffer.from("source-clock peaks fixture");
const durationSha = createHash("sha256").update(durationSource).digest("hex");
const durationLiveKey = `private/source/${durationVideoId}/${durationSha}`;
const durationOutputSeconds = 8;
const durationSourceSeconds = 20;
const durationLegacySeconds = 12;
const durationRevisionId = "srcdur48current";
const durationStaleRevisionId = "srcdur48stale";

function durationSpec(sourceSeconds: number, outputSeconds = sourceSeconds) {
	return {
		...untouchedEditorSpec(sourceSeconds),
		manualKeepRanges: [{ start: 0, end: outputSeconds }],
		keepRanges: [{ start: 0, end: outputSeconds }],
	};
}

function originPeaks(pairCount: number, providerDuration: number) {
	const bytes = encodePeaksObject({
		sourceSha256: durationSha,
		pairs: Array.from({ length: pairCount }, () => ({ min: -4, max: 4 })),
	});
	const body = {
		audio: "peaks",
		peaks: Buffer.from(bytes).toString("base64"),
		peaksSha256: createHash("sha256").update(bytes).digest("hex"),
		sourceSha256: durationSha,
		duration: providerDuration,
		sourceDuration: providerDuration,
	};
	return {
		status: 200,
		body,
		responseBytes: JSON.stringify(body).length,
		bytes,
	};
}

describe.skipIf(!peaksDurationDatabase)(
	"peaks duration uses the current source clock",
	() => {
		let durationPool: Pool;
		let durationDb: MySql2Database<Record<string, unknown>>;
		const outputMeta = {
			captionsVtt: "WEBVTT\n\n00:00:00.000 --> 00:00:08.000\nkept\n",
			chapters: [{ title: "Kept", start: 0 }],
			summaryStatus: "persisted" as const,
			summaryDerived: false as const,
			summaryText: "output summary stays",
			thumbnail: "unavailable" as const,
			durationSeconds: durationOutputSeconds,
		};
		const videoMeta = {
			summary: "output summary stays",
			chapters: [{ title: "Kept", start: 0 }],
			durationSeconds: durationOutputSeconds,
		};

		async function deleteDurationFixture() {
			const statements = [
				"DELETE FROM `outbox` WHERE videoId = ?",
				"DELETE FROM `source_relocation` WHERE videoId = ?",
				"DELETE FROM `source_object` WHERE videoId = ?",
				"DELETE FROM `video_edits` WHERE videoId = ?",
				"DELETE FROM `edit_revision` WHERE videoId = ?",
				"DELETE FROM `edit_intent` WHERE videoId = ?",
				"DELETE FROM `video_publication` WHERE videoId = ?",
				"DELETE FROM `videos` WHERE id = ?",
			];
			for (const statement of statements) {
				await durationPool.query(statement, [durationVideoId]);
			}
		}

		async function coreSnapshot() {
			const [video] = await durationDb
				.select()
				.from(schema.videos)
				.where(eq(schema.videos.id, durationVideoId));
			const [sourceRow] = await durationDb
				.select()
				.from(schema.sourceObject)
				.where(eq(schema.sourceObject.videoId, durationVideoId));
			const [publication] = await durationDb
				.select()
				.from(schema.videoPublication)
				.where(eq(schema.videoPublication.videoId, durationVideoId));
			const intents = await durationDb
				.select()
				.from(schema.editIntent)
				.where(eq(schema.editIntent.videoId, durationVideoId));
			const revisions = await durationDb
				.select()
				.from(schema.editRevision)
				.where(eq(schema.editRevision.videoId, durationVideoId));
			const [legacy] = await durationDb
				.select()
				.from(schema.videoEdits)
				.where(eq(schema.videoEdits.videoId, durationVideoId));
			const relocations = await durationDb
				.select()
				.from(schema.sourceRelocation)
				.where(eq(schema.sourceRelocation.videoId, durationVideoId));
			return {
				video: {
					ownerId: video?.ownerId,
					duration: video?.duration,
					metadata: video?.metadata,
					source: video?.source,
				},
				source: {
					liveKey: sourceRow?.liveKey,
					sha256: sourceRow?.sha256,
					relocationState: sourceRow?.relocationState,
				},
				publication: {
					currentRevisionId: publication?.currentRevisionId,
					currentGeneration: publication?.currentGeneration,
					generation: publication?.generation,
					publicationEpoch: publication?.publicationEpoch,
				},
				intents: intents
					.map((row) => ({
						generation: row.generation,
						intentId: row.intentId,
						canonicalSpec: row.canonicalSpec,
					}))
					.sort((left, right) => left.generation - right.generation),
				revisions: revisions
					.map((row) => ({
						revisionId: row.revisionId,
						generation: row.generation,
						state: row.state,
						metadataSnapshot: row.metadataSnapshot,
					}))
					.sort((left, right) => left.generation - right.generation),
				legacy: legacy?.editSpec ?? null,
				relocations: relocations.map((row) => ({
					oldKey: row.oldKey,
					newKey: row.newKey,
					state: row.state,
					sha256: row.sha256,
				})),
			};
		}

		async function seedEditedSource() {
			await deleteDurationFixture();
			const boundSourceId = sourceIdFromIdentity({
				key: durationLiveKey,
				sha256: durationSha,
				codec: "h264",
				timebase: "1/90000",
				frameMode: "cfr",
			});
			await durationDb.insert(schema.videos).values({
				id: durationVideoId,
				ownerId: durationOwnerId,
				orgId: durationOrgId,
				name: "source clock fixture",
				source: { type: "desktopMP4" },
				duration: durationOutputSeconds,
				metadata: videoMeta,
			});
			await durationDb.insert(schema.sourceObject).values({
				videoId: durationVideoId,
				liveKey: durationLiveKey,
				sha256: durationSha,
				codec: "h264",
				timebase: "1/90000",
				frameMode: "cfr",
				relocationState: "PURGED",
				a1Digest: durationSha,
				indexId: "bound-index",
				warmExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
			});
			await durationDb.insert(schema.sourceRelocation).values({
				videoId: durationVideoId,
				revisionId: "source",
				oldKey: `${durationOwnerId}/${durationVideoId}/result.mp4`,
				newKey: durationLiveKey,
				sha256: durationSha,
				state: "PURGED",
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
			});
			await durationDb.insert(schema.videoPublication).values({
				videoId: durationVideoId,
				currentRevisionId: durationRevisionId,
				currentGeneration: 1,
				generation: 1,
				latestDraftVersion: 1,
				draftSession: "source-clock",
				publicationEpoch: 1,
				policyEpoch: 0,
			});
			await durationDb.insert(schema.editIntent).values([
				{
					intentId: "srcdur48older",
					videoId: durationVideoId,
					sourceId: boundSourceId,
					generation: 0,
					draftVersion: 0,
					canonicalSpec: untouchedEditorSpec(durationOutputSeconds),
					mappingVersion: 1,
					encoderProfile: ENCODER_PROFILE,
					draftSession: "older",
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
				},
				{
					intentId: "srcdur48current",
					videoId: durationVideoId,
					sourceId: boundSourceId,
					generation: 1,
					draftVersion: 1,
					canonicalSpec: durationSpec(
						durationSourceSeconds,
						durationOutputSeconds,
					),
					mappingVersion: 1,
					encoderProfile: ENCODER_PROFILE,
					draftSession: "current",
					createdAt: new Date("2026-01-02T00:00:00.000Z"),
				},
				{
					intentId: "srcdur48newer",
					videoId: durationVideoId,
					sourceId: boundSourceId,
					generation: 3,
					draftVersion: 3,
					canonicalSpec: untouchedEditorSpec(durationOutputSeconds),
					mappingVersion: 1,
					encoderProfile: ENCODER_PROFILE,
					draftSession: "newer",
					createdAt: new Date("2026-01-03T00:00:00.000Z"),
				},
			]);
			await durationDb.insert(schema.editRevision).values([
				{
					revisionId: durationRevisionId,
					videoId: durationVideoId,
					intentId: "srcdur48current",
					sourceId: boundSourceId,
					generation: 1,
					state: "CURRENT",
					attempt: 1,
					createdAt: new Date("2026-01-02T00:00:00.000Z"),
					updatedAt: new Date("2026-01-02T00:00:00.000Z"),
					metadataSnapshot: outputMeta,
				},
				{
					revisionId: durationStaleRevisionId,
					videoId: durationVideoId,
					intentId: "srcdur48newer",
					sourceId: boundSourceId,
					generation: 3,
					state: "CURRENT",
					attempt: 1,
					createdAt: new Date("2026-01-03T00:00:00.000Z"),
					updatedAt: new Date("2026-01-03T00:00:00.000Z"),
					metadataSnapshot: outputMeta,
				},
			]);
			await durationDb.insert(schema.videoEdits).values({
				videoId: durationVideoId,
				sourceKey: durationLiveKey,
				editSpec: untouchedEditorSpec(durationLegacySeconds),
			});
			await durationDb.insert(schema.revisionOutbox).values({
				videoId: durationVideoId,
				revisionId: "srcprep",
				job: "source-prepare",
				createdAt: new Date("2026-01-04T00:00:00.000Z"),
				payload: {
					videoId: durationVideoId,
					ownerId: durationOwnerId,
					sourceObjectKey: durationLiveKey,
					stableKey: durationLiveKey,
					sha256: durationSha,
					attempts: 0,
					peaksOnly: true,
					phase: "peaks",
					notBeforeMs: 0,
				},
			});
		}

		async function deferOtherPrepareJobs() {
			const [rows] = await durationPool.query(
				"SELECT id, payload FROM outbox WHERE job = ? AND videoId <> ?",
				["source-prepare", durationVideoId],
			);
			const saved = (rows as Array<{ id: number; payload: unknown }>).map(
				(row) => ({
					id: row.id,
					payload: row.payload,
				}),
			);
			for (const row of saved) {
				const payload =
					typeof row.payload === "string"
						? (JSON.parse(row.payload) as Record<string, unknown>)
						: { ...(row.payload as Record<string, unknown>) };
				payload.notBeforeMs = Date.now() + 3_600_000;
				await durationPool.query("UPDATE outbox SET payload = ? WHERE id = ?", [
					JSON.stringify(payload),
					row.id,
				]);
			}
			return saved;
		}

		async function restoreOtherPrepareJobs(
			saved: Array<{ id: number; payload: unknown }>,
		) {
			for (const row of saved) {
				const payload =
					typeof row.payload === "string"
						? row.payload
						: JSON.stringify(row.payload);
				await durationPool.query("UPDATE outbox SET payload = ? WHERE id = ?", [
					payload,
					row.id,
				]);
			}
		}

		beforeAll(async () => {
			vi.stubEnv("CAP_INSTANT_FINISH_OWNERS", durationOwnerId);
			if (!peaksDurationDatabase) {
				throw new Error(
					"peaks duration fixture requires loopback cap57_test_regression",
				);
			}
			durationPool = createPool(peaksDurationDatabase);
			const [selected] = await durationPool.query("SELECT DATABASE() AS db");
			const connected = (selected as Array<{ db: string }>)[0]?.db;
			if (connected !== "cap57_test_regression") {
				throw new Error(
					"refusing peaks duration fixture outside cap57_test_regression",
				);
			}
			durationDb = drizzle(durationPool);
		});
		beforeEach(async () => {
			runtime.objects.clear();
			runtime.prepare.mockReset();
			runtime.publish.mockReset();
			runtime.requestPeaks.mockReset();
			origin.writeCaptions.mockClear();
			origin.prepareRevision.mockClear();
			origin.selectFrames.mockClear();
			origin.fetchArtifact.mockClear();
			runtime.refreshPolicy.mockClear();
			await seedEditedSource();
		});
		afterAll(async () => {
			if (durationPool) {
				await deleteDurationFixture();
				await durationPool.end();
			}
			vi.unstubAllEnvs();
		});

		it("persists source-length peaks when the current edit output is shorter than the source", async () => {
			const produced = originPeaks(
				durationSourceSeconds * PEAKS_PAIRS_PER_SEC,
				durationOutputSeconds,
			);
			runtime.requestPeaks.mockResolvedValue(produced);
			const before = await coreSnapshot();
			const held = await deferOtherPrepareJobs();
			try {
				const { drainSourcePrepare } = await import(
					"@/lib/source-prepare-worker"
				);
				await expect(
					drainSourcePrepare(durationDb as never, origin as never),
				).resolves.toEqual({ claimed: 1, encoded: 0 });
			} finally {
				await restoreOtherPrepareJobs(held);
			}
			const key = peaksObjectKey(durationVideoId, durationSha);
			expect(key).toBe(`private/peaks/${durationVideoId}/${durationSha}`);
			const stored = key ? runtime.objects.get(key) : undefined;
			if (!stored) throw new Error("source-length peaks were not stored");
			expect(createHash("sha256").update(stored).digest("hex")).toBe(
				produced.body.peaksSha256,
			);
			const decoded = decodePeaksObject(stored, durationSha);
			expect(decoded.ok).toBe(true);
			if (decoded.ok) {
				expect(decoded.pairs).toHaveLength(
					durationSourceSeconds * PEAKS_PAIRS_PER_SEC,
				);
				expect(decoded.noAudio).toBe(false);
			}
			expect(runtime.requestPeaks).toHaveBeenCalledWith(
				expect.objectContaining({
					videoId: durationVideoId,
					ownerId: durationOwnerId,
					sourceKey: durationLiveKey,
					sourceSha256: durationSha,
				}),
			);
			expect(
				await durationDb
					.select()
					.from(schema.revisionOutbox)
					.where(eq(schema.revisionOutbox.videoId, durationVideoId)),
			).toHaveLength(0);
			expect(await coreSnapshot()).toEqual(before);
			expect(runtime.prepare).not.toHaveBeenCalled();
			expect(runtime.publish).not.toHaveBeenCalled();
			expect(origin.writeCaptions).not.toHaveBeenCalled();
			expect(origin.prepareRevision).not.toHaveBeenCalled();
			expect(origin.selectFrames).not.toHaveBeenCalled();
			expect(origin.fetchArtifact).not.toHaveBeenCalled();
			expect(runtime.refreshPolicy).not.toHaveBeenCalled();
		});

		it("rejects peaks whose length matches the edited output instead of the source", async () => {
			const produced = originPeaks(
				durationOutputSeconds * PEAKS_PAIRS_PER_SEC,
				durationSourceSeconds,
			);
			runtime.requestPeaks.mockResolvedValue(produced);
			const before = await coreSnapshot();
			const held = await deferOtherPrepareJobs();
			try {
				const { drainSourcePrepare } = await import(
					"@/lib/source-prepare-worker"
				);
				await expect(
					drainSourcePrepare(durationDb as never, origin as never),
				).resolves.toEqual({ claimed: 1, encoded: 0 });
			} finally {
				await restoreOtherPrepareJobs(held);
			}
			const key = peaksObjectKey(durationVideoId, durationSha);
			expect(key ? runtime.objects.has(key) : false).toBe(false);
			const [job] = await durationDb
				.select()
				.from(schema.revisionOutbox)
				.where(eq(schema.revisionOutbox.videoId, durationVideoId));
			expect(job?.payload).toMatchObject({
				peaksOnly: true,
				ownerId: durationOwnerId,
				sha256: durationSha,
				sourceObjectKey: durationLiveKey,
				attempts: 1,
			});
			expect((job?.payload as { exhausted?: boolean }).exhausted).not.toBe(
				true,
			);
			expect(await coreSnapshot()).toEqual(before);
			expect(runtime.prepare).not.toHaveBeenCalled();
			expect(runtime.publish).not.toHaveBeenCalled();
			expect(origin.prepareRevision).not.toHaveBeenCalled();
			expect(origin.fetchArtifact).not.toHaveBeenCalled();
		});

		it("preserves no-audio peaks when source duration is unavailable", async () => {
			await durationPool.query(
				"UPDATE videos SET duration = NULL WHERE id = ?",
				[durationVideoId],
			);
			await durationPool.query(
				"UPDATE edit_intent SET canonicalSpec = 'null' WHERE videoId = ?",
				[durationVideoId],
			);
			await durationPool.query(
				"UPDATE video_edits SET editSpec = 'null' WHERE videoId = ?",
				[durationVideoId],
			);
			const bytes = encodePeaksObject({
				sourceSha256: durationSha,
				pairs: [],
				noAudio: true,
			});
			runtime.requestPeaks.mockImplementation(
				async (input: {
					videoId: string;
					sourceKey: string;
					sourceSha256: string;
					sourceDuration?: number;
				}) => {
					if (input.sourceDuration !== undefined)
						return { status: 400, body: null, responseBytes: 0 };
					const body = {
						audio: "none",
						peaks: Buffer.from(bytes).toString("base64"),
						peaksSha256: createHash("sha256").update(bytes).digest("hex"),
						sourceSha256: durationSha,
					};
					return {
						status: 200,
						body,
						responseBytes: JSON.stringify(body).length,
					};
				},
			);
			const before = await coreSnapshot();
			const held = await deferOtherPrepareJobs();
			try {
				const { drainSourcePrepare } = await import(
					"@/lib/source-prepare-worker"
				);
				await expect(
					drainSourcePrepare(durationDb as never, origin as never),
				).resolves.toEqual({ claimed: 1, encoded: 0 });
			} finally {
				await restoreOtherPrepareJobs(held);
			}
			const key = peaksObjectKey(durationVideoId, durationSha);
			const stored = key ? runtime.objects.get(key) : undefined;
			expect(stored).toEqual(Buffer.from(bytes));
			expect(runtime.requestPeaks).toHaveBeenCalledWith(
				expect.objectContaining({ sourceDuration: undefined }),
			);
			const jobs = await durationDb
				.select()
				.from(schema.revisionOutbox)
				.where(eq(schema.revisionOutbox.videoId, durationVideoId));
			expect(jobs).toHaveLength(0);
			expect(await coreSnapshot()).toEqual(before);
			expect(runtime.prepare).not.toHaveBeenCalled();
			expect(runtime.publish).not.toHaveBeenCalled();
			expect(origin.prepareRevision).not.toHaveBeenCalled();
			expect(origin.fetchArtifact).not.toHaveBeenCalled();
		});

		it("sends the resolved full source duration to the producer", async () => {
			const seen: Array<number | undefined> = [];
			runtime.requestPeaks.mockImplementation(
				async (input: {
					videoId: string;
					sourceKey: string;
					sourceSha256: string;
					sourceDuration?: number;
				}) => {
					seen.push(input.sourceDuration);
					return originPeaks(
						durationSourceSeconds * PEAKS_PAIRS_PER_SEC,
						durationSourceSeconds,
					);
				},
			);
			const before = await coreSnapshot();
			const held = await deferOtherPrepareJobs();
			try {
				const { drainSourcePrepare } = await import(
					"@/lib/source-prepare-worker"
				);
				await expect(
					drainSourcePrepare(durationDb as never, origin as never),
				).resolves.toEqual({ claimed: 1, encoded: 0 });
			} finally {
				await restoreOtherPrepareJobs(held);
			}
			expect(seen).toEqual([durationSourceSeconds]);
			expect(seen[0]).not.toBe(durationOutputSeconds);
			expect(seen[0]).not.toBe(durationLegacySeconds);
			expect(runtime.requestPeaks).toHaveBeenCalledTimes(1);
			expect(runtime.requestPeaks).toHaveBeenCalledWith(
				expect.objectContaining({
					videoId: durationVideoId,
					ownerId: durationOwnerId,
					sourceKey: durationLiveKey,
					sourceSha256: durationSha,
					sourceDuration: durationSourceSeconds,
				}),
			);
			const key = peaksObjectKey(durationVideoId, durationSha);
			const stored = key ? runtime.objects.get(key) : undefined;
			if (!stored) throw new Error("full-source peaks were not stored");
			const decoded = decodePeaksObject(stored, durationSha);
			expect(decoded.ok).toBe(true);
			if (decoded.ok) {
				expect(decoded.pairs).toHaveLength(
					durationSourceSeconds * PEAKS_PAIRS_PER_SEC,
				);
			}
			expect(await coreSnapshot()).toEqual(before);
			expect(runtime.prepare).not.toHaveBeenCalled();
			expect(runtime.publish).not.toHaveBeenCalled();
			expect(origin.prepareRevision).not.toHaveBeenCalled();
			expect(origin.fetchArtifact).not.toHaveBeenCalled();
		});
	},
);

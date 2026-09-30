import { createHash } from "node:crypto";
import * as schema from "@cap/database/schema";
import { Organisation, User, Video } from "@cap/web-domain";
import { getTableName } from "drizzle-orm";
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
		exists: async (key: string) => runtime.objects.has(key),
		request: async () => 404,
		presignGet: async () => "http://127.0.0.1/not-used",
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
}));
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
	await database
		.insert(schema.sourceRelocation)
		.values({
			videoId,
			revisionId: "source",
			oldKey,
			newKey: `private/source/${videoId}/${sha}`,
			sha256: sha,
			state: "PURGED",
			createdAt: new Date(),
		});
	await database
		.update(schema.videoPublication)
		.set({
			currentRevisionId: revisionId,
			currentGeneration: 1,
			generation: 1,
			publicationEpoch: 1,
		});
	await database
		.insert(schema.editIntent)
		.values({
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
	await database
		.insert(schema.editRevision)
		.values({
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
		origin.writeCaptions.mockClear();
		origin.prepareRevision.mockClear();
		captionBody = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nkeep\n";
		finishInventoryProbe.getObject = async () => null;
		await database
			.insert(schema.videos)
			.values({
				id: videoId,
				ownerId,
				orgId: Organisation.OrganisationId.make("o57parent00001"),
				name: "worker fixture",
				source: { type: "desktopMP4" },
				duration: 20,
			});
		await database
			.insert(schema.videoPublication)
			.values({
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
		await database
			.insert(schema.sourceObject)
			.values({
				videoId,
				liveKey: oldKey,
				sha256: sha,
				relocationState: "LIVE",
			});
		await database
			.insert(schema.sourceRelocation)
			.values({
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
		await database
			.update(schema.editRevision)
			.set({
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
		expect(await database.select().from(schema.revisionOutbox)).toHaveLength(0);
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
			expect(await database.select().from(schema.revisionOutbox)).toHaveLength(
				1,
			);
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
			await database
				.update(schema.videoPublication)
				.set({
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
		await database
			.update(schema.editRevision)
			.set({
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
		await database
			.insert(schema.editIntent)
			.values({
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
		await database
			.insert(schema.editRevision)
			.values({
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
		await database
			.update(schema.videoPublication)
			.set({
				currentRevisionId: "parentcut",
				currentGeneration: 2,
				generation: 3,
				publicationEpoch: 2,
				policyEpoch: 2,
			});
		await database
			.insert(schema.editRevision)
			.values({
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
		await database
			.update(schema.videos)
			.set({
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
		expect(await database.select().from(schema.revisionOutbox)).toHaveLength(0);
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
		await database
			.update(schema.videoPublication)
			.set({
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

	it("does not delete objects while purged captions are still pending", async () => {
		await seedAfterPointer({ purged: true });
		await database
			.update(schema.videos)
			.set({ transcriptionStatus: "COMPLETE" });
		const [revision] = await database.select().from(schema.editRevision);
		await database
			.update(schema.editRevision)
			.set({
				metadataSnapshot: {
					...revision!.metadataSnapshot!,
					captionsVtt: "WEBVTT\n",
				},
			});
		captionBody = "WEBVTT\n";
		const { drainSourcePrepare } = await import("@/lib/source-prepare-worker");
		await drainSourcePrepare(database as never, origin as never);
		expect(runtime.deletes).toEqual([]);
		expect(runtime.objects.has(oldKey)).toBe(true);
		expect(runtime.objects.has(privateKey)).toBe(true);
		expect(await database.select().from(schema.revisionOutbox)).toHaveLength(1);
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
		await database
			.update(schema.sourceObject)
			.set({
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

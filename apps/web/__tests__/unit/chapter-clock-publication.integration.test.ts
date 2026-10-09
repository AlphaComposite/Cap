import { readFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	comments,
	editRevision,
	sourceObject,
	sourceRelocation,
	videoEdits,
	videoPublication,
	videos,
} from "@cap/database/schema";
import type { VideoEditSpecV2 } from "@cap/database/types";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { Effect, Option } from "effect";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://127.0.0.1:30410" },
	serverEnv: () => ({
		NEXTAUTH_SECRET: "test-secret-with-enough-entropy",
		WEB_URL: "http://127.0.0.1:30410",
	}),
}));
vi.mock("@/lib/server", () => ({
	runPromise: async (effect: unknown) => effect,
}));
vi.mock("@/lib/ai/provider", () => ({
	isAiConfigured: () => true,
}));
vi.mock("@/lib/ai/run", () => ({
	runWithAiProviders: async (
		_operation: string,
		run: (selection: {
			model: () => object;
			defaultMaxOutputTokens: number;
		}) => Promise<unknown>,
	) =>
		run({
			model: () => ({}),
			defaultMaxOutputTokens: 8000,
		}),
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: (effect: Effect.Effect<unknown>) =>
		Effect.runPromise(effect),
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: vi.fn(),
}));

const GENERATED = [
	{ title: "Opening", start: 0 },
	{ title: "Early phase", start: 8 },
	{ title: "Removed section", start: 25 },
	{ title: "Shifted section", start: 40 },
	{ title: "Later phase", start: 60 },
];
const TRANSCRIPT = `WEBVTT

00:00:00.000 --> 00:00:08.000
Opening words about the work.

00:00:08.000 --> 00:00:25.000
Early phase continues here.

00:00:25.000 --> 00:00:40.000
Removed section stays in source.

00:00:40.000 --> 00:00:60.000
Shifted section after the cut.

00:01:00.000 --> 00:01:30.000
Later phase covers the ending.
`;

vi.mock("ai", () => ({
	APICallError: { isInstance: () => false },
	generateText: vi.fn(async () => ({
		text: JSON.stringify({
			title: "Generated title",
			chapters: GENERATED,
		}),
	})),
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					getObject: () => Effect.succeed(Option.some(TRANSCRIPT)),
				},
			]),
	},
}));

import { generateText } from "ai";
import { deriveRevisionChapterState } from "@/lib/revision-chapter-source";
import { snapsCoveringRanges } from "@/lib/revision-duration-check";
import {
	signOriginAttestation,
	verifyInternalServiceRequest,
} from "@/lib/revision-media-token";
import {
	finishInventoryProbe,
	prepareInstantFinishRevision,
	publishInstantFinishRevision,
	runRevisionReadback,
} from "@/lib/revision-publication";
import {
	chaptersDocument,
	sha256Hex,
} from "@/lib/revision-publication-metadata";
import type {
	OriginClient,
	RevisionPrepareBody,
	RevisionPrepareResult,
} from "@/lib/revision-publication-origin";
import { getInstantFinishPublicationDto } from "@/lib/revision-publication-read";
import { generateAiWorkflow } from "@/workflows/generate-ai";

const fixtureDir = process.env.CAP_TEST_FIXTURE_DIR;
const suite = describe.skipIf(
	!fixtureDir && !process.env.CAP_CHAPTER_CLOCK_MYSQL,
);

function regressionUrl() {
	if (process.env.CAP_CHAPTER_CLOCK_MYSQL)
		return process.env.CAP_CHAPTER_CLOCK_MYSQL;
	if (!fixtureDir) return "";
	const text = readFileSync(path.join(fixtureDir, "parent-test.env"), "utf8");
	const values: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("export ") || !line.includes("=")) continue;
		const eqAt = line.indexOf("=");
		const key = line.slice(7, eqAt);
		let value = line
			.slice(eqAt + 1)
			.trim()
			.replace(/^"|"$/g, "");
		for (const [existing, substitution] of Object.entries(values)) {
			value = value.replace(`$${existing}`, substitution);
		}
		values[key] = value;
	}
	const base = values.CAP_SOURCE_PREPARE_MYSQL ?? "";
	const query = base.indexOf("?");
	const dbPath = query === -1 ? base : base.slice(0, query);
	const suffix = "/cap57_test_basic";
	if (!dbPath.endsWith(suffix)) {
		throw new Error("refusing source database other than cap57_test_basic");
	}
	const url = `${dbPath.slice(0, -suffix.length)}/cap57_test_regression${query === -1 ? "" : base.slice(query)}`;
	const match = url.match(
		/^mysql:\/\/(?:[^@/]+)@([^:/]+)(?::(\d+))?\/([^?/\s]+)/,
	);
	if (!match) throw new Error("refusing unparseable disposable database url");
	const host = match[1];
	const database = match[3];
	if (host !== "127.0.0.1" && host !== "localhost") {
		throw new Error(`refusing non-local database host ${host}`);
	}
	if (database !== "cap57_test_regression") {
		throw new Error(`refusing database ${database}`);
	}
	return url;
}

const databaseUrl = regressionUrl();
if (databaseUrl) {
	process.env.DATABASE_URL = databaseUrl;
	process.env.CAP_WIRE_A_DATABASE_URL = databaseUrl;
}

const token = "wire-a-test-token";
const ownerId = "clkf1owner00001";
const orgId = "clkf1org0000001";
const videoId = "clkf1video00001";
const laterVideoId = "clkf1video00002";
const commentId = "clkf1cmnt000001";
const migrationsFolder = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../packages/database/migrations",
);
const OLD_CHAPTERS = [{ title: "Old opening", start: 0 }];

type Prepared = RevisionPrepareBody & {
	init: Buffer;
	seg0: Buffer;
	playlist: string;
	thumb: Buffer;
};

class FakeOrigin {
	readonly prepared = new Map<string, Prepared>();
	onPrepare: ((body: RevisionPrepareBody) => Promise<void>) | undefined;
	server = createServer((req, res) => {
		void this.handle(req, res);
	});
	url = "";

	start(): Promise<void> {
		return new Promise((resolve) => {
			this.server.listen(0, "127.0.0.1", () => {
				const address = this.server.address();
				if (!address || typeof address === "string") throw new Error("no port");
				this.url = `http://127.0.0.1:${address.port}`;
				resolve();
			});
		});
	}

	close(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	client(): OriginClient {
		return {
			prepareRevision: async (body) => {
				const response = await fetch(
					`${this.url}/internal/revisions/${body.revisionId}/prepare`,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-cap-internal-token": token,
						},
						body: JSON.stringify(body),
					},
				);
				if (!response.ok) throw new Error(`prepare ${response.status}`);
				const attestationBody = await response.text();
				const payload = JSON.parse(attestationBody) as RevisionPrepareResult;
				return {
					...payload,
					attestationMac:
						response.headers.get("x-cap-origin-attestation") ?? "",
					attestationBody,
				};
			},
			selectFrames: async (body) => ({
				sourceId: body.sourceId,
				sourceSha256: body.sourceSha256,
				a1Digest: body.a1Digest,
				indexId: body.indexId,
				keepIndexes: body.keepRanges.map((_, index) => index),
				keepRanges: body.keepRanges.map((range) => ({
					start: range.start,
					end: range.end,
				})),
			}),
			fetchArtifact: async (input) => {
				const response = await fetch(
					`${this.url}/media/${input.videoId}/r/${input.revisionId}/${input.name}`,
					{
						method: input.method,
						headers: { "x-cap-internal-token": token },
					},
				);
				const body =
					input.method === "HEAD"
						? Buffer.alloc(0)
						: Buffer.from(await response.arrayBuffer());
				return {
					status: response.status,
					body,
					contentType: response.headers.get("content-type"),
				};
			},
		};
	}

	private authorized(req: IncomingMessage, requestPath: string, body: Buffer) {
		if (req.headers["x-cap-internal-token"] === token) return true;
		const header = req.headers["x-cap-origin-service"];
		return (
			typeof header === "string" &&
			verifyInternalServiceRequest(header, {
				method: req.method ?? "GET",
				path: requestPath,
				body,
			})
		);
	}

	private async handle(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", "http://origin.local");
		if (
			req.method === "POST" &&
			url.pathname.endsWith("/prepare") &&
			url.pathname.includes("/internal/revisions/")
		) {
			const raw = Buffer.concat(await readBody(req));
			if (!this.authorized(req, url.pathname, raw)) {
				res.writeHead(401).end("unauthorized");
				return;
			}
			const body = JSON.parse(raw.toString("utf8")) as RevisionPrepareBody;
			if (this.onPrepare) await this.onPrepare(body);
			const init = Buffer.from(`0000ftypisom${body.revisionId}`);
			const seg0 = Buffer.from(`0000moofmdat${body.revisionId}`);
			const playlist = `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:${snapsCoveringRanges(body.keepRanges, 1000).durationSeconds.toFixed(3)},\nseg/0.m4s\n#EXT-X-ENDLIST\n`;
			const note = Buffer.from(
				`duration_seconds=${body.durationSeconds.toFixed(3)}`,
			);
			const thumb = Buffer.concat([
				Buffer.from([
					0xff,
					0xd8,
					0xff,
					0xfe,
					(note.length + 2) >> 8,
					(note.length + 2) & 0xff,
				]),
				note,
				Buffer.from([0xff, 0xd9]),
			]);
			this.prepared.set(body.revisionId, {
				...body,
				init,
				seg0,
				playlist,
				thumb,
			});
			const snap = snapsCoveringRanges(body.keepRanges, 1000);
			const payload = {
				attestationVersion: 2,
				ready: true,
				intentId: body.intentId,
				decoded: true,
				decodedFrames: 1,
				seg0DecodedFrames: 1,
				playlistHasEndList: true,
				initSha256: sha256Hex(init),
				seg0Sha256: sha256Hex(seg0),
				playlistDurationSeconds: snap.durationSeconds,
				durationSeconds: snap.durationSeconds,
				durationTicks: snap.durationTicks,
				timescale: snap.timescale,
				maxHoldTicks: snap.maxHoldTicks,
				rangeSnaps: snap.rangeSnaps,
			};
			const attestationBody = `${JSON.stringify(payload)}\n`;
			res
				.writeHead(200, {
					"content-type": "application/json",
					"x-cap-origin-attestation": signOriginAttestation(attestationBody),
				})
				.end(attestationBody);
			return;
		}
		const media = url.pathname.match(/^\/media\/([^/]+)\/r\/([^/]+)\/(.+)$/);
		if (!media) {
			res.writeHead(404).end();
			return;
		}
		const prepared = this.prepared.get(media[2] ?? "");
		const name = media[3] ?? "";
		const payload = prepared
			? name === "chapters.json"
				? Buffer.from(prepared.chaptersJson)
				: name === "playlist.m3u8"
					? Buffer.from(prepared.playlist)
					: name === "captions.vtt"
						? Buffer.from(prepared.captionsVtt)
						: name === "init.mp4"
							? prepared.init
							: name === "seg/0.m4s"
								? prepared.seg0
								: name === "thumbnail.jpg"
									? prepared.thumb
									: null
			: null;
		if (!payload) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { "content-length": String(payload.length) });
		res.end(req.method === "HEAD" ? undefined : payload);
	}
}

function readBody(req: IncomingMessage) {
	return new Promise<Buffer[]>((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		req.on("end", () => resolve(chunks));
		req.on("error", reject);
	});
}

function spec(
	ranges: { start: number; end: number }[],
	sourceDuration = 90,
): VideoEditSpecV2 {
	return {
		version: 2,
		sourceDuration,
		manualKeepRanges: ranges,
		keepRanges: ranges,
		autoCuts: {
			silence: {
				enabled: false,
				ranges: [],
				thresholdMs: 0,
				padMs: 0,
				removedMs: 0,
				gapCount: 0,
			},
			fillers: {
				enabled: false,
				ranges: [],
				mode: "ums",
				padMs: 0,
				removedCount: 0,
				skippedCount: 0,
			},
		},
	};
}

function connect(pool: mysql.Pool) {
	return drizzle(pool);
}

suite("prepared chapter snapshot cannot overwrite a later AI save", () => {
	const origin = new FakeOrigin();
	const fullSpec = spec([{ start: 0, end: 90 }]);
	const cutSpec = spec([
		{ start: 0, end: 20 },
		{ start: 50, end: 90 },
	]);
	let database: ReturnType<typeof connect>;
	let pool: mysql.Pool;

	beforeAll(async () => {
		const parsed = new URL(databaseUrl);
		if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
			throw new Error("refusing non-local database host");
		}
		if (
			!["/cap57_test_regression", "/cap57_test_chapters"].includes(
				parsed.pathname,
			)
		) {
			throw new Error("refusing non-test chapter database");
		}
		process.env.CAP_INSTANT_FINISH_OWNERS = ownerId;
		process.env.REVISION_ORIGIN_SERVICE_SECRET =
			"wire-a-origin-service-secret-32b";
		finishInventoryProbe.listPrefix = async () => [];
		await origin.start();
		process.env.CAP_INSTANT_FINISH_ORIGIN_URL = origin.url;
		pool = mysql.createPool(databaseUrl);
		database = connect(pool);
		await migrate(database, { migrationsFolder });
		await cleanup(videoId);
		await cleanup(laterVideoId);
	}, 180_000);

	afterAll(async () => {
		finishInventoryProbe.listPrefix = undefined;
		origin.onPrepare = undefined;
		await origin.close();
		if (pool) {
			await cleanup(videoId);
			await cleanup(laterVideoId);
			await pool.end();
		}
	});

	async function cleanup(id: string) {
		await pool.query("DELETE FROM outbox WHERE videoId = ?", [id]);
		await pool.query("DELETE FROM comments WHERE videoId = ?", [id]);
		await pool.query("DELETE FROM source_relocation WHERE videoId = ?", [id]);
		await pool.query(
			"DELETE FROM revision_artifact_status WHERE revisionId IN (SELECT revisionId FROM edit_revision WHERE videoId = ?)",
			[id],
		);
		await pool.query("DELETE FROM edit_revision WHERE videoId = ?", [id]);
		await pool.query("DELETE FROM edit_intent WHERE videoId = ?", [id]);
		await pool.query("DELETE FROM video_publication WHERE videoId = ?", [id]);
		await pool.query("DELETE FROM source_object WHERE videoId = ?", [id]);
		await pool.query("DELETE FROM video_edits WHERE videoId = ?", [id]);
		await pool.query("DELETE FROM videos WHERE id = ?", [id]);
	}

	async function seedVideo(id: string) {
		await cleanup(id);
		await database.insert(videos).values({
			id: id as never,
			ownerId: ownerId as never,
			orgId: orgId as never,
			name: "Manual title",
			source: { type: "webMP4" },
			duration: 90,
			transcriptionStatus: "COMPLETE",
			metadata: {
				summary: "Saved summary",
				titleManuallyEdited: true,
				chapters: OLD_CHAPTERS,
				sourceChapters: OLD_CHAPTERS,
				aiGenerationStatus: "QUEUED",
				aiGenerationId: "generation-1",
				aiChapterBackfillGenerationId: "generation-1",
			},
		});
		await database.insert(videoEdits).values({
			videoId: id as never,
			sourceKey: `${ownerId}/${id}/source/original.mp4`,
			editSpec: {
				version: 1,
				sourceDuration: 90,
				keepRanges: [{ start: 0, end: 90 }],
			},
		});
		await database.insert(sourceObject).values({
			videoId: id as never,
			liveKey: `private/source/${id}/wireopaque`,
			sha256: "b".repeat(64),
			relocationState: "PURGED",
			codec: "h264",
			timebase: "1/15360",
			frameMode: "vfr",
			a1Digest: "c".repeat(64),
			indexId: "index-1",
			warmExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
		await database.insert(sourceRelocation).values({
			videoId: id as never,
			revisionId: "relocate",
			oldKey: `${ownerId}/${id}/source/original.mp4`,
			newKey: `private/source/${id}/wireopaque`,
			sha256: "b".repeat(64),
			state: "PURGED",
			createdAt: new Date(),
		});
	}

	async function publicationRow(id: string) {
		const [row] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, id as never));
		return row;
	}

	async function videoMetadata(id: string) {
		const [row] = await database
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, id as never));
		return row?.metadata;
	}

	it("aborts a stale prepared flip, then a fresh retry publishes matching chapters", async () => {
		await seedVideo(videoId);
		await database.insert(comments).values({
			id: commentId as never,
			type: "text",
			content: "inside the later cut",
			timestamp: 30,
			authorId: ownerId as never,
			videoId: videoId as never,
		});
		const established = await publishInstantFinishRevision(
			database,
			{
				videoId,
				editSpec: fullSpec,
				baseGeneration: 0,
				draftVersion: 1,
				draftSession: "editor",
				chapters: OLD_CHAPTERS,
				sourceChapters: OLD_CHAPTERS,
				sourceDuration: 90,
			},
			{ origin: origin.client() },
		);
		const before = await publicationRow(videoId);
		expect(before?.currentRevisionId).toBe(established.revisionId);
		origin.onPrepare = async () => {
			await generateAiWorkflow({
				videoId,
				userId: ownerId,
				generationId: "generation-1",
			});
		};
		const stale = publishInstantFinishRevision(
			database,
			{
				videoId,
				editSpec: cutSpec,
				baseGeneration: before?.generation ?? 1,
				draftVersion: (before?.latestDraftVersion ?? 1) + 1,
				draftSession: "editor",
				chapters: OLD_CHAPTERS,
				sourceChapters: OLD_CHAPTERS,
				sourceDuration: 90,
			},
			{ origin: origin.client() },
		);
		await expect(stale).rejects.toMatchObject({
			status: 409,
			name: "RevisionPublicationError",
		});
		const afterConflict = await publicationRow(videoId);
		expect(afterConflict?.currentRevisionId).toBe(established.revisionId);
		const saved = await videoMetadata(videoId);
		expect(saved?.sourceChapters).toEqual(GENERATED);
		expect(saved?.chaptersRevisionId).toBe(established.revisionId);
		expect(saved?.summary).toBe("Saved summary");
		const [comment] = await database
			.select({ timestamp: comments.timestamp })
			.from(comments)
			.where(eq(comments.id, commentId as never));
		expect(comment?.timestamp).toBe(30);
		origin.onPrepare = undefined;
		const aiCallsBeforeRetry = vi.mocked(generateText).mock.calls.length;
		const dto = await getInstantFinishPublicationDto({
			videoId,
			ownerId,
			database,
		});
		const retried = await publishInstantFinishRevision(
			database,
			{
				videoId,
				editSpec: cutSpec,
				baseGeneration: afterConflict?.generation ?? 1,
				draftVersion: (afterConflict?.latestDraftVersion ?? 1) + 1,
				draftSession: "editor",
				chapters: dto.revisionMetadata.chapters,
				sourceChapters:
					saved?.chaptersRevisionId === dto.currentRevisionId
						? (saved?.sourceChapters ?? null)
						: null,
				sourceDuration: 90,
			},
			{ origin: origin.client() },
		);
		expect(retried.revisionId).not.toBe(established.revisionId);
		const fresh = deriveRevisionChapterState({
			storedChapters: saved?.chapters ?? [],
			storedSourceChapters: saved?.sourceChapters ?? null,
			previousSpec: fullSpec,
			nextSpec: cutSpec,
		});
		const artifact = origin.prepared.get(retried.revisionId)?.chaptersJson;
		expect(artifact).toBe(
			chaptersDocument({
				chapters: fresh.chapters,
				durationSeconds: cutSpec.keepRanges.reduce(
					(total, range) => total + (range.end - range.start),
					0,
				),
				sourceId: origin.prepared.get(retried.revisionId)?.sourceId ?? "",
			}),
		);
		const [revision] = await database
			.select({ metadataSnapshot: editRevision.metadataSnapshot })
			.from(editRevision)
			.where(eq(editRevision.revisionId, retried.revisionId as string));
		const readback = await videoMetadata(videoId);
		const publishedDto = await getInstantFinishPublicationDto({
			videoId,
			ownerId,
			database,
		});
		expect(revision?.metadataSnapshot?.chapters).toEqual(fresh.chapters);
		expect(readback?.chapters).toEqual(fresh.chapters);
		expect(readback?.sourceChapters).toEqual(fresh.sourceChapters);
		expect(readback?.chaptersRevisionId).toBe(retried.revisionId);
		expect(publishedDto.currentRevisionId).toBe(retried.revisionId);
		expect(publishedDto.revisionMetadata.chapters).toEqual(fresh.chapters);
		expect(JSON.parse(artifact ?? "{}").chapters).toEqual(fresh.chapters);
		const staleArtifact = origin.prepared.get(
			[...origin.prepared.keys()].find(
				(id) => id !== established.revisionId && id !== retried.revisionId,
			) ?? "",
		);
		expect(staleArtifact?.chaptersJson).toContain("Old opening");
		expect(staleArtifact?.chaptersJson).not.toBe(artifact);
		expect(vi.mocked(generateText).mock.calls.length).toBe(aiCallsBeforeRetry);
		expect(afterConflict?.currentRevisionId).not.toBe(retried.revisionId);
	});

	it("re-prepares READY artifacts when AI chapters change before Done", async () => {
		await seedVideo(laterVideoId);
		const identity = await publishInstantFinishRevision(
			database,
			{
				videoId: laterVideoId,
				editSpec: fullSpec,
				baseGeneration: 0,
				draftVersion: 1,
				draftSession: "editor",
				chapters: OLD_CHAPTERS,
				sourceChapters: OLD_CHAPTERS,
			},
			{ origin: origin.client() },
		);
		const before = await publicationRow(laterVideoId);
		const input = {
			videoId: laterVideoId,
			editSpec: cutSpec,
			baseGeneration: before?.generation ?? 0,
			draftVersion: 2,
			draftSession: "editor",
			chapters: OLD_CHAPTERS,
			sourceChapters: OLD_CHAPTERS,
		};
		const prepared = await prepareInstantFinishRevision(database, input, {
			origin: origin.client(),
		});
		const oldArtifact = origin.prepared.get(prepared.revisionId)?.chaptersJson;
		expect(oldArtifact).toContain("Old opening");
		await generateAiWorkflow({
			videoId: laterVideoId,
			userId: ownerId,
			generationId: "generation-1",
		});
		// AI updates DB metadata, not the prepared origin artifact.
		expect(origin.prepared.get(prepared.revisionId)?.chaptersJson).toBe(
			oldArtifact,
		);
		const metadata = await videoMetadata(laterVideoId);
		const published = await publishInstantFinishRevision(
			database,
			{
				...input,
				chapters: metadata?.chapters,
				sourceChapters: metadata?.sourceChapters,
			},
			{ origin: origin.client() },
		);
		const readback = await runRevisionReadback(database, {
			revisionId: published.revisionId,
			origin: origin.client(),
		});
		expect(readback).toMatchObject({
			ok: true,
			reverted: false,
			skipped: false,
		});
		expect(published.revisionId).not.toBe(prepared.revisionId);
		expect(published.revisionId).not.toBe(identity.revisionId);
		expect((await publicationRow(laterVideoId))?.currentRevisionId).toBe(
			published.revisionId,
		);
		expect(origin.prepared.get(published.revisionId)?.chaptersJson).not.toBe(
			oldArtifact,
		);
	});

	it("projects an AI save through the revision that flipped before the save", async () => {
		await seedVideo(laterVideoId);
		const published = await publishInstantFinishRevision(
			database,
			{
				videoId: laterVideoId,
				editSpec: cutSpec,
				baseGeneration: 0,
				draftVersion: 1,
				draftSession: "editor",
				chapters: OLD_CHAPTERS,
				sourceChapters: OLD_CHAPTERS,
				sourceDuration: 90,
			},
			{ origin: origin.client() },
		);
		const preparedChapters = origin.prepared.get(
			published.revisionId,
		)?.chaptersJson;
		await generateAiWorkflow({
			videoId: laterVideoId,
			userId: ownerId,
			generationId: "generation-1",
		});
		expect(origin.prepared.get(published.revisionId)?.chaptersJson).toBe(
			preparedChapters,
		);
		expect(
			await runRevisionReadback(database, {
				revisionId: published.revisionId,
				origin: origin.client(),
			}),
		).toMatchObject({ ok: true, reverted: false, skipped: false });
		const metadata = await videoMetadata(laterVideoId);
		const expected = deriveRevisionChapterState({
			storedChapters: [],
			storedSourceChapters: GENERATED,
			previousSpec: cutSpec,
			nextSpec: cutSpec,
		});
		expect(metadata?.sourceChapters).toEqual(GENERATED);
		expect(metadata?.chaptersRevisionId).toBe(published.revisionId);
		expect(metadata?.chapters).toEqual(expected.chapters);
		expect(metadata?.summary).toBe("Saved summary");
	});
});

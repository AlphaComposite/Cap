import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	comments,
	editIntent,
	sourceObject,
	sourceRelocation,
	videoEdits,
	videos,
} from "@cap/database/schema";
import type { VideoEditSpecV2 } from "@cap/database/types";
import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://127.0.0.1:30457" },
	serverEnv: () => ({
		NEXTAUTH_SECRET: "frame-selection-nextauth-secret",
		WEB_URL: "http://127.0.0.1:30457",
	}),
}));
vi.mock("@/lib/server", () => ({
	runPromise: async (effect: unknown) => effect,
}));

import {
	getEditTranscriptObjectKey,
	serializeEditTranscript,
} from "@/lib/edit-transcript";
import { encryptEditTranscriptObject } from "@/lib/edit-transcript-storage";
import { snapsCoveringRanges } from "@/lib/revision-duration-check";
import { signOriginAttestation } from "@/lib/revision-media-token";
import {
	finishInventoryProbe,
	prepareInstantFinishRevision,
	publishInstantFinishRevision,
	RevisionPublicationError,
} from "@/lib/revision-publication";
import {
	ENCODER_PROFILE,
	intentIdFor,
	MAPPING_VERSION,
	remapCommentTimestamp,
	sha256Hex,
	sourceIdFromIdentity,
} from "@/lib/revision-publication-metadata";
import type {
	FrameSelectionRequest,
	OriginClient,
	RevisionPrepareBody,
} from "@/lib/revision-publication-origin";
import { untouchedEditorSpec } from "@/lib/source-prepare";
import {
	getEditSpecOutputDuration,
	normalizeVideoEditSpec,
} from "@/lib/video-edits";

const databaseUrl = process.env.CAP_WIRE_A_DATABASE_URL;
const ownerId = "fzp57owner00001";
const orgId = "fzp57org0000001";
const serviceSecret = "frame-selection-service-secret-32";
const migrationsFolder = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../packages/database/migrations",
);
const islands = [
	{ start: 0.5, end: 0.57 },
	{ start: 1.3, end: 1.37 },
	{ start: 2.1, end: 2.17 },
];

function cutSpec(): VideoEditSpecV2 {
	return {
		version: 2,
		sourceDuration: 3,
		manualKeepRanges: [{ start: 0, end: 3 }],
		keepRanges: [{ start: 0, end: 3 }],
		autoCuts: {
			silence: {
				enabled: true,
				ranges: [
					{ start: 0.4, end: 0.5 },
					{ start: 1.2, end: 1.3 },
					{ start: 2, end: 2.1 },
				],
				thresholdMs: 800,
				padMs: 150,
				removedMs: 300,
				gapCount: 3,
			},
			fillers: {
				enabled: true,
				ranges: [
					{ start: 0.57, end: 0.7 },
					{ start: 1.37, end: 1.5 },
					{ start: 2.17, end: 2.3 },
				],
				mode: "ums",
				padMs: 80,
				removedCount: 3,
				skippedCount: 0,
			},
		},
	};
}

class SelectingOrigin {
	readonly prepared: RevisionPrepareBody[] = [];
	selectCalls = 0;
	mode: "omit" | "empty" | "race" = "omit";
	onSelect: (() => Promise<void>) | null = null;
	private readonly init = Buffer.from("ftyp-frame-init");
	private readonly segment = Buffer.from("moof-frame-seg0");
	private playlist = "#EXTM3U\n#EXT-X-ENDLIST\n";

	client(): OriginClient {
		return {
			prepareRevision: async (body) => {
				this.prepared.push(body);
				const snap = snapsCoveringRanges(body.keepRanges, 1000);
				this.playlist = `#EXTM3U\n#EXTINF:${snap.durationSeconds.toFixed(3)},\nseg/0.m4s\n#EXT-X-ENDLIST\n`;
				const payload = {
					attestationVersion: 2 as const,
					segmentPlanVersion: 3,
					ready: true,
					intentId: body.intentId,
					decoded: true,
					decodedFrames: 1,
					seg0DecodedFrames: 1,
					playlistHasEndList: true as const,
					initSha256: sha256Hex(this.init),
					seg0Sha256: sha256Hex(this.segment),
					playlistDurationSeconds: snap.durationSeconds,
					durationSeconds: snap.durationSeconds,
					durationTicks: snap.durationTicks,
					timescale: snap.timescale,
					maxHoldTicks: snap.maxHoldTicks,
					rangeSnaps: snap.rangeSnaps,
				};
				const attestationBody = `${JSON.stringify(payload)}\n`;
				return {
					...payload,
					attestationMac: signOriginAttestation(attestationBody),
					attestationBody,
				};
			},
			selectFrames: async (body: FrameSelectionRequest) => {
				this.selectCalls += 1;
				if (this.onSelect) await this.onSelect();
				if (this.mode === "empty") {
					return {
						...body,
						keepIndexes: [],
						keepRanges: [],
					};
				}
				const keepIndexes = body.keepRanges.flatMap((range, index) =>
					islands.some(
						(island) =>
							island.start === range.start && island.end === range.end,
					)
						? []
						: [index],
				);
				return {
					sourceId: body.sourceId,
					sourceSha256: body.sourceSha256,
					a1Digest: body.a1Digest,
					indexId: body.indexId,
					keepIndexes,
					keepRanges: keepIndexes.map((index) => {
						const range = body.keepRanges[index];
						if (!range) throw new Error("missing selected range");
						return { start: range.start, end: range.end };
					}),
				};
			},
			fetchArtifact: async (input) => {
				const latest = this.prepared.at(-1);
				const body =
					input.method === "HEAD"
						? Buffer.alloc(0)
						: input.name === "playlist.m3u8"
							? Buffer.from(this.playlist)
							: input.name === "init.mp4"
								? this.init
								: input.name === "seg/0.m4s"
									? this.segment
									: input.name === "captions.vtt"
										? Buffer.from(latest?.captionsVtt ?? "")
										: input.name === "chapters.json"
											? Buffer.from(latest?.chaptersJson ?? "")
											: Buffer.alloc(0);
				return {
					status: 200,
					body,
					contentType:
						input.name === "playlist.m3u8"
							? "application/vnd.apple.mpegurl"
							: "application/octet-stream",
				};
			},
			requestDownload: async () => ({ status: 202 }),
			writeCaptions: async (input) => ({
				sha256: sha256Hex(Buffer.from(input.captionsVtt)),
			}),
		};
	}
}

describe.skipIf(!databaseUrl)("source-frame canonicalization", () => {
	let database: MySql2Database<Record<string, unknown>>;
	let pool: mysql.Pool;
	const origin = new SelectingOrigin();

	beforeAll(async () => {
		vi.stubEnv("DATABASE_URL", databaseUrl ?? "");
		vi.stubEnv("CAP_INSTANT_FINISH_OWNERS", ownerId);
		vi.stubEnv("REVISION_ORIGIN_SERVICE_SECRET", serviceSecret);
		vi.stubEnv("WEB_URL", "http://127.0.0.1:30457");
		vi.stubEnv("NEXTAUTH_URL", "http://127.0.0.1:30457");
		vi.stubEnv("NEXTAUTH_SECRET", "frame-selection-nextauth-secret");
		finishInventoryProbe.listPrefix = async () => [];
		pool = mysql.createPool(databaseUrl ?? "");
		database = drizzle(pool);
		await migrate(database, { migrationsFolder });
	}, 180_000);

	afterAll(async () => {
		finishInventoryProbe.listPrefix = undefined;
		finishInventoryProbe.getObject = undefined;
		vi.unstubAllEnvs();
		await pool.end();
	});

	async function reset(videoId: string) {
		await pool.query("DELETE FROM comments WHERE videoId = ?", [videoId]);
		await pool.query("DELETE FROM outbox WHERE videoId = ?", [videoId]);
		await pool.query(
			"DELETE FROM revision_artifact_status WHERE revisionId IN (SELECT revisionId FROM edit_revision WHERE videoId = ?)",
			[videoId],
		);
		await pool.query("DELETE FROM edit_revision WHERE videoId = ?", [videoId]);
		await pool.query("DELETE FROM edit_intent WHERE videoId = ?", [videoId]);
		await pool.query("DELETE FROM source_relocation WHERE videoId = ?", [
			videoId,
		]);
		await pool.query("DELETE FROM source_object WHERE videoId = ?", [videoId]);
		await pool.query("DELETE FROM video_publication WHERE videoId = ?", [
			videoId,
		]);
		await pool.query("DELETE FROM video_edits WHERE videoId = ?", [videoId]);
		await pool.query("DELETE FROM videos WHERE id = ?", [videoId]);
		origin.prepared.length = 0;
		origin.selectCalls = 0;
		origin.mode = "omit";
		origin.onSelect = null;
		finishInventoryProbe.getObject = undefined;
	}

	async function seed(videoId: string, warmExpiresAt: Date) {
		const liveKey = `private/source/${videoId}/wireopaque`;
		await database.insert(videos).values({
			id: videoId as never,
			ownerId: ownerId as never,
			orgId: orgId as never,
			source: { type: "webMP4" },
			duration: 3,
			metadata: { chapters: [{ title: "Island", start: 0.535 }] },
		});
		await database.insert(videoEdits).values({
			videoId: videoId as never,
			sourceKey: `${ownerId}/${videoId}/source/original.mp4`,
			editSpec: {
				version: 1,
				sourceDuration: 3,
				keepRanges: [{ start: 0, end: 3 }],
			},
		});
		await database.insert(comments).values({
			id: `fzp57cmt${videoId.slice(-4)}` as never,
			type: "text",
			content: "island",
			timestamp: 0.535,
			authorId: ownerId as never,
			videoId: videoId as never,
		});
		await database.insert(sourceObject).values({
			videoId: videoId as never,
			liveKey,
			sha256: "b".repeat(64),
			relocationState: "PURGED",
			codec: "h264",
			timebase: "1/16000",
			frameMode: "vfr",
			a1Digest: "c".repeat(64),
			indexId: "index-frame",
			warmExpiresAt,
		});
		await database.insert(sourceRelocation).values({
			videoId: videoId as never,
			revisionId: "relocate",
			oldKey: `${ownerId}/${videoId}/source/original.mp4`,
			newKey: liveKey,
			sha256: "b".repeat(64),
			state: "PURGED",
			createdAt: new Date(),
		});
	}

	it("canonicalizes prepare and publish before hashing and drops island metadata", async () => {
		const videoId = "fzp57framevid01";
		await reset(videoId);
		await seed(videoId, new Date(Date.now() + 60 * 60 * 1000));
		const transcriptKey = getEditTranscriptObjectKey(ownerId, videoId);
		finishInventoryProbe.getObject = async (key) =>
			key === transcriptKey
				? encryptEditTranscriptObject(
						serializeEditTranscript({
							version: 3,
							speechModelUsed: "test",
							durationMs: 3000,
							languageCode: "en",
							words: [
								{
									id: "kept",
									text: "keptword",
									startMs: 100,
									endMs: 200,
									confidence: 1,
									speaker: null,
									channel: null,
								},
								{
									id: "island",
									text: "islandword",
									startMs: 520,
									endMs: 550,
									confidence: 1,
									speaker: null,
									channel: null,
								},
							],
						}),
						ownerId,
						videoId,
					)
				: null;
		const input = {
			videoId,
			editSpec: cutSpec(),
			baseGeneration: 0,
			draftVersion: 1,
			draftSession: "editor",
			chapters: [{ title: "Island", start: 0.535 }],
		};
		const prepared = await prepareInstantFinishRevision(database, input, {
			origin: origin.client(),
		});
		const published = await publishInstantFinishRevision(database, input, {
			origin: origin.client(),
		});
		expect(published.revisionId).toBe(prepared.revisionId);
		const normalized = normalizeVideoEditSpec(cutSpec());
		if (normalized.version !== 2) throw new Error("expected v2");
		const selected = normalized.keepRanges.filter(
			(range) =>
				!islands.some(
					(island) => island.start === range.start && island.end === range.end,
				),
		);
		expect(selected).toHaveLength(normalized.keepRanges.length - 3);
		expect(
			getEditSpecOutputDuration(normalized) -
				getEditSpecOutputDuration({ ...normalized, keepRanges: selected }),
		).toBeCloseTo(0.21, 6);
		expect(origin.prepared[0]?.keepRanges).toEqual(selected);
		expect(origin.prepared[0]?.editSpec.keepRanges).toEqual(selected);
		expect(origin.prepared[0]?.editSpec.manualKeepRanges).toEqual(
			normalized.manualKeepRanges,
		);
		expect(origin.prepared[0]?.editSpec.autoCuts.silence.padMs).toBe(150);
		const sourceId = sourceIdFromIdentity({
			key: `private/source/${videoId}/wireopaque`,
			sha256: "b".repeat(64),
			codec: "h264",
			timebase: "1/16000",
			frameMode: "vfr",
		});
		const canonical = origin.prepared[0]?.editSpec;
		if (!canonical) throw new Error("prepare did not record a spec");
		const intentId = intentIdFor({
			sourceId,
			spec: canonical,
			mappingVersion: MAPPING_VERSION,
			profile: ENCODER_PROFILE,
		});
		expect(origin.prepared[0]?.intentId).toBe(intentId);
		expect(origin.prepared[0]?.captionsVtt).toContain("keptword");
		expect(origin.prepared[0]?.captionsVtt).not.toContain("islandword");
		expect(origin.prepared[0]?.captionsVtt).toContain(
			`duration_seconds=${getEditSpecOutputDuration(canonical).toFixed(3)}`,
		);
		const [intent] = await database
			.select({ canonicalSpec: editIntent.canonicalSpec })
			.from(editIntent)
			.where(eq(editIntent.videoId, videoId as never));
		expect((intent?.canonicalSpec as VideoEditSpecV2).keepRanges).toEqual(
			selected,
		);
		const [comment] = await database
			.select({ timestamp: comments.timestamp })
			.from(comments)
			.where(eq(comments.videoId, videoId as never));
		expect(comment?.timestamp).toBeNull();
		const again = await publishInstantFinishRevision(
			database,
			{
				...input,
				baseGeneration: published.generation,
				draftVersion: 2,
			},
			{ origin: origin.client() },
		);
		expect(again.revisionId).toBe(published.revisionId);
		const [revisions] = await pool.query(
			"SELECT COUNT(*) AS n FROM edit_revision WHERE videoId = ?",
			[videoId],
		);
		expect(Number((revisions as { n: number }[])[0]?.n)).toBe(1);
		await database
			.update(comments)
			.set({ timestamp: 0.53 })
			.where(eq(comments.videoId, videoId as never));
		const next = {
			...cutSpec(),
			manualKeepRanges: [{ start: 0, end: 1.8 }],
			keepRanges: [{ start: 0, end: 1.8 }],
			autoCuts: {
				...cutSpec().autoCuts,
				silence: { ...cutSpec().autoCuts.silence, enabled: false, ranges: [] },
				fillers: { ...cutSpec().autoCuts.fillers, enabled: false, ranges: [] },
			},
		};
		const storedPrevious = intent?.canonicalSpec as VideoEditSpecV2;
		const nextNormalized = normalizeVideoEditSpec(next);
		if (nextNormalized.version !== 2) throw new Error("expected v2");
		const viaStored = remapCommentTimestamp({
			timestamp: 0.53,
			previousSpec: storedPrevious,
			nextSpec: nextNormalized,
		});
		const viaRecomputed = remapCommentTimestamp({
			timestamp: 0.53,
			previousSpec: normalizeVideoEditSpec(storedPrevious),
			nextSpec: nextNormalized,
		});
		expect(viaStored).not.toBe(viaRecomputed);
		await publishInstantFinishRevision(
			database,
			{
				videoId,
				editSpec: next,
				expectedEditSpec: cutSpec(),
				baseGeneration: published.generation,
				draftVersion: 3,
				draftSession: "editor",
			},
			{ origin: origin.client() },
		);
		const [moved] = await database
			.select({ timestamp: comments.timestamp })
			.from(comments)
			.where(eq(comments.videoId, videoId as never));
		expect(moved?.timestamp).toBe(viaStored);
	}, 60_000);

	it("fails a source race and an empty selection before allocation", async () => {
		const videoId = "fzp57framevid02";
		await reset(videoId);
		await seed(videoId, new Date(Date.now() + 60 * 60 * 1000));
		origin.mode = "race";
		origin.onSelect = async () => {
			await database
				.update(sourceObject)
				.set({ sha256: "d".repeat(64), a1Digest: "e".repeat(64) })
				.where(eq(sourceObject.videoId, videoId as never));
		};
		await expect(
			publishInstantFinishRevision(
				database,
				{
					videoId,
					editSpec: cutSpec(),
					baseGeneration: 0,
					draftVersion: 1,
					draftSession: "editor",
				},
				{ origin: origin.client() },
			),
		).rejects.toBeInstanceOf(RevisionPublicationError);
		const [raced] = await pool.query(
			"SELECT COUNT(*) AS n FROM edit_revision WHERE videoId = ?",
			[videoId],
		);
		expect(Number((raced as { n: number }[])[0]?.n)).toBe(0);
		await database
			.update(sourceObject)
			.set({ sha256: "b".repeat(64), a1Digest: "c".repeat(64) })
			.where(eq(sourceObject.videoId, videoId as never));
		origin.mode = "empty";
		origin.onSelect = null;
		await expect(
			prepareInstantFinishRevision(
				database,
				{
					videoId,
					editSpec: cutSpec(),
					baseGeneration: 0,
					draftVersion: 1,
					draftSession: "editor",
				},
				{ origin: origin.client() },
			),
		).rejects.toMatchObject({ status: 400 });
		const [empty] = await pool.query(
			"SELECT COUNT(*) AS n FROM edit_revision WHERE videoId = ?",
			[videoId],
		);
		expect(Number((empty as { n: number }[])[0]?.n)).toBe(0);
	}, 60_000);

	it("reuses an untouched finish after warm expiry without selecting frames", async () => {
		const videoId = "fzp57framevid03";
		await reset(videoId);
		await seed(videoId, new Date(Date.now() + 60 * 60 * 1000));
		const identity = untouchedEditorSpec(3);
		const first = await publishInstantFinishRevision(
			database,
			{
				videoId,
				editSpec: identity,
				baseGeneration: 0,
				draftVersion: 1,
				draftSession: "editor",
			},
			{ origin: origin.client() },
		);
		const callsAfterFirst = origin.selectCalls;
		expect(callsAfterFirst).toBeGreaterThan(0);
		await database
			.update(sourceObject)
			.set({ warmExpiresAt: new Date(Date.now() - 60_000) })
			.where(eq(sourceObject.videoId, videoId as never));
		const second = await publishInstantFinishRevision(
			database,
			{
				videoId,
				editSpec: identity,
				baseGeneration: first.generation,
				draftVersion: 2,
				draftSession: "editor",
			},
			{ origin: origin.client() },
		);
		expect(second.revisionId).toBe(first.revisionId);
		expect(origin.selectCalls).toBe(callsAfterFirst);
	}, 60_000);
});

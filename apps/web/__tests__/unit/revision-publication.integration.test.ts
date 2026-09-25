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
	videoEdits,
	videoPublication,
	videos,
} from "@cap/database/schema";
import type { VideoEditSpecV2 } from "@cap/database/types";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	claimArtifactLease,
	publishInstantFinishRevision,
} from "@/lib/revision-publication";
import {
	RevisionPublicationError,
	sha256Hex,
} from "@/lib/revision-publication-metadata";
import type {
	OriginClient,
	RevisionPrepareBody,
} from "@/lib/revision-publication-origin";
import {
	bumpPublicationPolicyEpoch,
	getInstantFinishPublicationDto,
	resolveRollbackSourceKey,
} from "@/lib/revision-publication-read";

const databaseUrl = process.env.CAP_WIRE_A_DATABASE_URL;
const token = "wire-a-test-token";
const ownerId = "wireaowner00001";
const videoId = "wireavideo00001";
const migrationsFolder = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../packages/database/migrations",
);

type Prepared = RevisionPrepareBody & {
	init: Buffer;
	seg0: Buffer;
	playlist: string;
	thumb: Buffer;
};

class FakeOrigin {
	readonly prepared = new Map<string, Prepared>();
	failCaptions = false;
	server = createServer((req, res) => this.handle(req, res));
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
				return response.json() as Promise<{
					decoded: boolean;
					decodedFrames: number;
					initSha256: string;
					seg0Sha256: string;
					playlistDurationSeconds: number;
				}>;
			},
			fetchArtifact: async (input) => {
				const response = await fetch(
					`${this.url}/media/${input.videoId}/r/${input.revisionId}/${input.name}`,
					{ method: input.method, headers: { "x-cap-internal-token": token } },
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

	private handle(req: IncomingMessage, res: ServerResponse) {
		if (req.headers["x-cap-internal-token"] !== token) {
			res.writeHead(401).end("unauthorized");
			return;
		}
		const url = new URL(req.url ?? "/", "http://origin.local");
		if (
			req.method === "POST" &&
			url.pathname.endsWith("/prepare") &&
			url.pathname.includes("/internal/revisions/")
		) {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			req.on("end", () => {
				const body = JSON.parse(
					Buffer.concat(chunks).toString("utf8"),
				) as RevisionPrepareBody;
				const init = Buffer.from(`0000ftypisom${body.revisionId}`);
				const seg0 = Buffer.from(`0000moofmdat${body.revisionId}`);
				const playlist = `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:${body.durationSeconds.toFixed(3)},\nseg/0.m4s\n#EXT-X-ENDLIST\n`;
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
				res.writeHead(200, { "content-type": "application/json" }).end(
					JSON.stringify({
						decoded: true,
						decodedFrames: 1,
						initSha256: sha256Hex(init),
						seg0Sha256: sha256Hex(seg0),
						playlistDurationSeconds: body.durationSeconds,
					}),
				);
			});
			return;
		}
		const media = url.pathname.match(/^\/media\/([^/]+)\/r\/([^/]+)\/(.+)$/);
		if (!media) {
			res.writeHead(404).end();
			return;
		}
		const prepared = this.prepared.get(media[2] ?? "");
		if (!prepared) {
			res.writeHead(404).end();
			return;
		}
		const name = media[3] ?? "";
		if (name === "captions.vtt" && this.failCaptions) {
			res.writeHead(500).end("injected metadata failure");
			return;
		}
		const payload =
			name === "init.mp4"
				? prepared.init
				: name === "seg/0.m4s"
					? prepared.seg0
					: name === "playlist.m3u8"
						? Buffer.from(prepared.playlist)
						: name === "captions.vtt"
							? Buffer.from(prepared.captionsVtt)
							: name === "chapters.json"
								? Buffer.from(prepared.chaptersJson)
								: name === "thumbnail.jpg"
									? prepared.thumb
									: null;
		if (!payload) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { "content-length": String(payload.length) });
		res.end(req.method === "HEAD" ? undefined : payload);
	}
}

function spec(end = 2): VideoEditSpecV2 {
	return {
		version: 2,
		sourceDuration: 9,
		manualKeepRanges: [{ start: 0, end }],
		keepRanges: [{ start: 0, end }],
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

describe.skipIf(!databaseUrl)("revision publication fence", () => {
	const origin = new FakeOrigin();
	let database: ReturnType<typeof connect>;
	let pool: mysql.Pool;

	beforeAll(async () => {
		process.env.DATABASE_URL = databaseUrl;
		process.env.CAP_INSTANT_FINISH_OWNERS = ownerId;
		process.env.CAP_INSTANT_FINISH_INTERNAL_TOKEN = token;
		await origin.start();
		process.env.CAP_INSTANT_FINISH_ORIGIN_URL = origin.url;
		pool = mysql.createPool(databaseUrl ?? "");
		database = connect(pool);
		await migrate(database, { migrationsFolder });
		await pool.query("DELETE FROM outbox WHERE videoId = ?", [videoId]);
		await pool.query("DELETE FROM source_relocation WHERE videoId = ?", [
			videoId,
		]);
		await pool.query(
			"DELETE FROM revision_artifact_status WHERE revisionId IN (SELECT revisionId FROM edit_revision WHERE videoId = ?)",
			[videoId],
		);
		await pool.query("DELETE FROM edit_revision WHERE videoId = ?", [videoId]);
		await pool.query("DELETE FROM edit_intent WHERE videoId = ?", [videoId]);
		await pool.query("DELETE FROM video_publication WHERE videoId = ?", [
			videoId,
		]);
		await pool.query("DELETE FROM source_object WHERE videoId = ?", [videoId]);
		await pool.query("DELETE FROM comments WHERE videoId = ?", [videoId]);
		await pool.query("DELETE FROM video_edits WHERE videoId = ?", [videoId]);
		await pool.query("DELETE FROM video_uploads WHERE video_id = ?", [videoId]);
		await pool.query("DELETE FROM videos WHERE id = ?", [videoId]);
		await database.insert(videos).values({
			id: videoId as never,
			ownerId: ownerId as never,
			orgId: "wireaorg0000001" as never,
			source: { type: "webMP4" },
			duration: 9,
			metadata: {
				summary: "pasted summary",
				chapters: [{ title: "Early", start: 0.2 }],
			},
		});
		await database.insert(videoEdits).values({
			videoId: videoId as never,
			sourceKey: `${ownerId}/${videoId}/source/original.mp4`,
			editSpec: {
				version: 1,
				sourceDuration: 9,
				keepRanges: [{ start: 0, end: 9 }],
			},
		});
		await database.insert(comments).values([
			{
				id: "wireacmnt000001" as never,
				type: "text",
				content: "kept",
				timestamp: 0.2,
				authorId: ownerId as never,
				videoId: videoId as never,
			},
			{
				id: "wireacmnt000002" as never,
				type: "text",
				content: "removed",
				timestamp: 8.2,
				authorId: ownerId as never,
				videoId: videoId as never,
			},
		]);
		await database.insert(sourceObject).values({
			videoId: videoId as never,
			liveKey: `${ownerId}/${videoId}/source/original.mp4`,
			sha256: "b".repeat(64),
			relocationState: "LIVE",
			codec: "h264",
			timebase: "1/15360",
			frameMode: "vfr",
			a1Digest: "c".repeat(64),
			indexId: "index-1",
			warmExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
	}, 180_000);

	afterAll(async () => {
		await origin.close();
		await pool.end();
	});

	it("applies migration up, rejects a duplicate generation, and drops the new tables", async () => {
		const [tables] = await pool.query(
			"SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('edit_intent','edit_revision','video_publication','revision_artifact_status','outbox','source_object','source_relocation')",
		);
		expect(
			(tables as { name: string }[]).map((row) => row.name).sort(),
		).toEqual([
			"edit_intent",
			"edit_revision",
			"outbox",
			"revision_artifact_status",
			"source_object",
			"source_relocation",
			"video_publication",
		]);
		await expect(
			pool.query(
				"INSERT INTO edit_intent (videoId, generation, intentId, sourceId, canonicalSpec, mappingVersion, encoderProfile, draftVersion, draftSession, createdAt) VALUES (?, 0, ?, 'source', JSON_OBJECT(), 1, JSON_OBJECT(), 1, 's', NOW(3)), (?, 0, ?, 'source', JSON_OBJECT(), 1, JSON_OBJECT(), 1, 's', NOW(3))",
				[videoId, "a".repeat(64), videoId, "b".repeat(64)],
			),
		).rejects.toThrow(/Duplicate/);
		const sql = readFileSync(
			path.join(migrationsFolder, "0047_brown_spitfire.sql"),
			"utf8",
		);
		await pool.query("SET FOREIGN_KEY_CHECKS=0");
		await pool.query(
			"DROP TABLE outbox, source_relocation, revision_artifact_status, edit_revision, edit_intent, video_publication, source_object",
		);
		const [gone] = await pool.query(
			"SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'video_publication'",
		);
		expect(Number((gone as { n: number }[])[0]?.n)).toBe(0);
		for (const statement of sql.split("--> statement-breakpoint")) {
			const query = statement.trim();
			if (query) await pool.query(query);
		}
		await pool.query("SET FOREIGN_KEY_CHECKS=1");
		await database.insert(sourceObject).values({
			videoId: videoId as never,
			liveKey: `${ownerId}/${videoId}/source/original.mp4`,
			sha256: "b".repeat(64),
			relocationState: "LIVE",
			codec: "h264",
			timebase: "1/15360",
			frameMode: "vfr",
			a1Digest: "c".repeat(64),
			indexId: "index-1",
			warmExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
	});

	it("publishes R1 only after the fence and keeps the legacy rows unchanged", async () => {
		const published = await publishInstantFinishRevision(
			database,
			{
				videoId,
				editSpec: spec(2),
				baseGeneration: 0,
				draftVersion: 1,
				draftSession: "editor",
				chapters: [{ title: "Early", start: 0.2 }],
			},
			{ origin: origin.client() },
		);
		expect(published).toEqual({
			success: true,
			revisionId: published.revisionId,
			generation: 1,
		});
		const [pointer] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(pointer?.currentRevisionId).toBe(published.revisionId);
		const again = await publishInstantFinishRevision(
			database,
			{
				videoId,
				editSpec: spec(2),
				baseGeneration: 1,
				draftVersion: 1,
				draftSession: "editor",
			},
			{ origin: origin.client() },
		);
		expect(again.revisionId).toBe(published.revisionId);
		const [uploads] = await pool.query(
			"SELECT COUNT(*) AS n FROM video_uploads WHERE video_id = ?",
			[videoId],
		);
		expect(Number((uploads as { n: number }[])[0]?.n)).toBe(0);
		const [video] = await database
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId as never));
		expect(video?.metadata?.summary).toBe("pasted summary");
		expect(video?.metadata?.editProcessing).toBeUndefined();
		const [edit] = await database
			.select()
			.from(videoEdits)
			.where(eq(videoEdits.videoId, videoId as never));
		expect(edit?.sourceKey).toBe(`${ownerId}/${videoId}/source/original.mp4`);
		expect(edit?.editSpec).toMatchObject({ version: 1 });
		const kept = await database
			.select()
			.from(comments)
			.where(eq(comments.id, "wireacmnt000001" as never));
		const removed = await database
			.select()
			.from(comments)
			.where(eq(comments.id, "wireacmnt000002" as never));
		expect(kept[0]?.timestamp).toBeCloseTo(0.2, 5);
		expect(removed[0]?.timestamp).toBeNull();
		const dto = await getInstantFinishPublicationDto({
			videoId,
			ownerId,
			database,
		});
		expect(dto.enabled).toBe(true);
		expect(dto.currentRevisionId).toBe(published.revisionId);
		expect(dto.revisionMetadata.summaryDerived).toBe(false);
		expect(dto.revisionMetadata.summaryText).toBe("pasted summary");
		expect(dto.revisionMetadata.playlistPath).toContain(
			`/r/${published.revisionId}/`,
		);
		expect(dto.revisionMetadata.download).toBe("preparing");
		const lease = await claimArtifactLease(database, {
			revisionId: published.revisionId,
			artifact: "download",
			leaseMs: 30_000,
		});
		expect(lease.claimed).toBe(true);
		const secondLease = await claimArtifactLease(database, {
			revisionId: published.revisionId,
			artifact: "download",
			leaseMs: 30_000,
		});
		expect(secondLease.claimed).toBe(false);
		expect(await resolveRollbackSourceKey(videoId, "old/key", database)).toBe(
			`${ownerId}/${videoId}/source/original.mp4`,
		);
		expect(await bumpPublicationPolicyEpoch(videoId, database)).toBe(1);
	});

	it("returns 409 for a stale generation or an older same-session draft and does not move current", async () => {
		const [before] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		await expect(
			publishInstantFinishRevision(
				database,
				{
					videoId,
					editSpec: spec(3),
					baseGeneration: 0,
					draftVersion: before?.latestDraftVersion ?? 1,
					draftSession: "editor",
				},
				{ origin: origin.client() },
			),
		).rejects.toBeInstanceOf(RevisionPublicationError);
		const { recordServerDraft } = await import("@/lib/revision-publication");
		await recordServerDraft(database, {
			videoId,
			draftVersion: (before?.latestDraftVersion ?? 1) + 2,
			draftSession: "editor",
		});
		await expect(
			publishInstantFinishRevision(
				database,
				{
					videoId,
					editSpec: spec(3),
					baseGeneration: before?.generation ?? 1,
					draftVersion: before?.latestDraftVersion ?? 1,
					draftSession: "editor",
				},
				{ origin: origin.client() },
			),
		).rejects.toMatchObject({ status: 409 });
		const [after] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(after?.currentRevisionId).toBe(before?.currentRevisionId);
	});

	it("blocks 200 and CURRENT when metadata readback fails, then retries with a fresh revision", async () => {
		const [before] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		origin.failCaptions = true;
		await expect(
			publishInstantFinishRevision(
				database,
				{
					videoId,
					editSpec: spec(4),
					baseGeneration: before?.generation ?? 0,
					draftVersion: (before?.latestDraftVersion ?? 0) + 1,
					draftSession: "editor",
				},
				{ origin: origin.client() },
			),
		).rejects.toMatchObject({ status: 500 });
		origin.failCaptions = false;
		const [mid] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(mid?.currentRevisionId).toBe(before?.currentRevisionId);
		const retried = await publishInstantFinishRevision(
			database,
			{
				videoId,
				editSpec: spec(4),
				baseGeneration: mid?.generation ?? 0,
				draftVersion: (mid?.latestDraftVersion ?? 0) + 1,
				draftSession: "editor",
			},
			{ origin: origin.client() },
		);
		expect(retried.revisionId).not.toBe(before?.currentRevisionId);
		const failed = await database
			.select()
			.from(editRevision)
			.where(eq(editRevision.videoId, videoId as never));
		expect(failed.some((row) => row.state === "FAILED")).toBe(true);
		expect(
			failed
				.filter((row) => row.state === "CURRENT")
				.map((row) => row.revisionId),
		).toContain(retried.revisionId);
	});

	it("does not let a stale S0 become current after a newer generation flips", async () => {
		const [before] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		let winner = "";
		await expect(
			publishInstantFinishRevision(
				database,
				{
					videoId,
					editSpec: spec(5),
					baseGeneration: before?.generation ?? 0,
					draftVersion: (before?.latestDraftVersion ?? 0) + 1,
					draftSession: "editor",
				},
				{
					origin: origin.client(),
					onAllocated: async (allocated) => {
						const next = await publishInstantFinishRevision(
							database,
							{
								videoId,
								editSpec: spec(6),
								baseGeneration: allocated.generation,
								draftVersion: (before?.latestDraftVersion ?? 0) + 2,
								draftSession: "editor",
							},
							{ origin: origin.client() },
						);
						winner = next.revisionId;
					},
				},
			),
		).rejects.toBeInstanceOf(RevisionPublicationError);
		const [after] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(after?.currentRevisionId).toBe(winner);
		expect(winner).not.toBe(before?.currentRevisionId);
		const stale = await database
			.select()
			.from(editRevision)
			.where(eq(editRevision.videoId, videoId as never));
		expect(stale.some((row) => row.state === "SUPERSEDED")).toBe(true);
		expect(
			stale.find((row) => row.state === "SUPERSEDED")?.revisionId,
		).not.toBe(after?.currentRevisionId);
	});

	it("runs the Next action against the fake origin and returns R1 only", async () => {
		vi.resetModules();
		const [before] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		vi.doMock("@cap/database/auth/session", () => ({
			getCurrentUser: async () => ({
				id: ownerId,
				stripeSubscriptionStatus: "active",
			}),
		}));
		vi.doMock("@cap/utils", () => ({
			userIsPro: () => true,
		}));
		vi.doMock("next/cache", () => ({ revalidatePath: () => undefined }));
		const action = await import("@/actions/videos/publish-revision");
		const published = await action.publishVideoRevision({
			videoId: videoId as never,
			editSpec: spec(7),
			baseGeneration: before?.generation ?? 0,
			draftVersion: (before?.latestDraftVersion ?? 0) + 1,
			draftSession: "editor",
		});
		expect(published.success).toBe(true);
		expect(published.revisionId).not.toBe(before?.currentRevisionId);
		const [uploads] = await pool.query(
			"SELECT COUNT(*) AS n FROM video_uploads",
		);
		expect(Number((uploads as { n: number }[])[0]?.n)).toBe(0);
		expect(origin.prepared.get(published.revisionId)?.playlist).toContain(
			"seg/0.m4s",
		);
		expect(origin.prepared.get(published.revisionId)?.playlist).not.toContain(
			"result.mp4",
		);
	});
});

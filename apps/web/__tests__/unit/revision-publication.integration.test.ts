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
	revisionOutbox,
	sourceObject,
	sourceRelocation,
	videoEdits,
	videoPublication,
	videos,
} from "@cap/database/schema";
import type { VideoEditSpecV2 } from "@cap/database/types";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
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

import {
	signOriginAttestation,
	verifyInternalServiceRequest,
} from "@/lib/revision-media-token";
import { PUBLISH_JOINED_PREPARE } from "@/lib/revision-prepare-abort";
import {
	claimArtifactLease,
	claimRevisionReadback,
	completeRevisionReadback,
	prepareInstantFinishRevision,
	publishInstantFinishRevision,
	sweepRevisionReadbacks,
} from "@/lib/revision-publication";
import {
	RevisionPublicationError,
	sha256Hex,
} from "@/lib/revision-publication-metadata";
import type {
	OriginClient,
	RevisionPrepareBody,
	RevisionPrepareResult,
} from "@/lib/revision-publication-origin";
import {
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
	artifactReads = 0;
	preparePosts = 0;
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
				this.preparePosts += 1;
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

	private authorized(req: IncomingMessage, path: string, body: Buffer) {
		if (req.headers["x-cap-internal-token"] === token) return true;
		const header = req.headers["x-cap-origin-service"];
		return (
			typeof header === "string" &&
			verifyInternalServiceRequest(header, {
				method: req.method ?? "GET",
				path,
				body,
			})
		);
	}

	private handle(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", "http://origin.local");
		const internal = url.pathname.match(
			/^\/internal\/revisions\/([^/]+)\/artifact\/(.+)$/,
		);
		if (internal) {
			url.pathname = `/media/${videoId}/r/${internal[1]}/${internal[2]}`;
		}
		if (
			req.method !== "POST" &&
			!this.authorized(
				req,
				new URL(req.url ?? "/", "http://origin.local").pathname,
				Buffer.alloc(0),
			)
		) {
			res.writeHead(401).end("unauthorized");
			return;
		}
		if (
			req.method === "POST" &&
			url.pathname.endsWith("/prepare") &&
			url.pathname.includes("/internal/revisions/")
		) {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			req.on("end", () => {
				const raw = Buffer.concat(chunks);
				if (
					!this.authorized(
						req,
						new URL(req.url ?? "/", "http://origin.local").pathname,
						raw,
					)
				) {
					res.writeHead(401).end("unauthorized");
					return;
				}
				const body = JSON.parse(raw.toString("utf8")) as RevisionPrepareBody;
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
				const payload = {
					ready: true,
					intentId: body.intentId,
					decoded: true,
					decodedFrames: 1,
					seg0DecodedFrames: 1,
					playlistHasEndList: true,
					initSha256: sha256Hex(init),
					seg0Sha256: sha256Hex(seg0),
					playlistDurationSeconds: body.durationSeconds,
					durationSeconds: body.durationSeconds,
				};
				const attestationBody = `${JSON.stringify(payload)}\n`;
				res
					.writeHead(200, {
						"content-type": "application/json",
						"x-cap-origin-attestation": signOriginAttestation(attestationBody),
					})
					.end(attestationBody);
			});
			return;
		}
		const media = url.pathname.match(/^\/media\/([^/]+)\/r\/([^/]+)\/(.+)$/);
		if (!media) {
			res.writeHead(404).end();
			return;
		}
		this.artifactReads += 1;
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
		process.env.REVISION_ORIGIN_SERVICE_SECRET =
			"wire-a-origin-service-secret-32b";
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
			liveKey: `private/source/${videoId}/wireopaque`,
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
			videoId: videoId as never,
			revisionId: "relocate",
			oldKey: `${ownerId}/${videoId}/source/original.mp4`,
			newKey: `private/source/${videoId}/wireopaque`,
			sha256: "b".repeat(64),
			state: "PURGED",
			createdAt: new Date(),
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
			liveKey: `private/source/${videoId}/wireopaque`,
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
			videoId: videoId as never,
			revisionId: "relocate",
			oldKey: `${ownerId}/${videoId}/source/original.mp4`,
			newKey: `private/source/${videoId}/wireopaque`,
			sha256: "b".repeat(64),
			state: "PURGED",
			createdAt: new Date(),
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
			`private/source/${videoId}/wireopaque`,
		);
		const [publication] = await database
			.select({ policyEpoch: videoPublication.policyEpoch })
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(publication?.policyEpoch).toBe(1);
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

	it("flips on a signed attestation, then reverts CURRENT when async readback fails", async () => {
		const [before] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		origin.failCaptions = true;
		origin.artifactReads = 0;
		const published = await publishInstantFinishRevision(
			database,
			{
				videoId,
				editSpec: spec(4),
				baseGeneration: before?.generation ?? 0,
				draftVersion: (before?.latestDraftVersion ?? 0) + 1,
				draftSession: "editor",
			},
			{ origin: origin.client() },
		);
		expect(published.success).toBe(true);
		expect(origin.artifactReads).toBe(0);
		const [flipped] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(flipped?.currentRevisionId).toBe(published.revisionId);
		await sweepRevisionReadbacks(database, { origin: origin.client() });
		origin.failCaptions = false;
		const [reverted] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(reverted?.currentRevisionId).toBe(before?.currentRevisionId);
		const failed = await database
			.select()
			.from(editRevision)
			.where(eq(editRevision.videoId, videoId as never));
		expect(
			failed.find((row) => row.revisionId === published.revisionId)?.state,
		).toBe("FAILED");
		const retried = await publishInstantFinishRevision(
			database,
			{
				videoId,
				editSpec: spec(4),
				baseGeneration: reverted?.generation ?? 0,
				draftVersion: (reverted?.latestDraftVersion ?? 0) + 1,
				draftSession: "editor",
			},
			{ origin: origin.client() },
		);
		expect(retried.revisionId).not.toBe(published.revisionId);
		await sweepRevisionReadbacks(database, { origin: origin.client() });
		const [after] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(after?.currentRevisionId).toBe(retried.revisionId);
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
		const { POST } = await import("@/app/api/video/revision/publish/route");
		const response = await POST(
			new Request("http://127.0.0.1:30410/api/video/revision/publish", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://127.0.0.1:30410",
					host: "127.0.0.1:30410",
					"x-forwarded-host": "127.0.0.1:30410",
				},
				body: JSON.stringify({
					videoId,
					editSpec: spec(7),
					baseGeneration: before?.generation ?? 0,
					draftVersion: (before?.latestDraftVersion ?? 0) + 1,
					draftSession: "editor",
				}),
			}) as never,
		);
		const published = (await response.json()) as {
			success: boolean;
			revisionId: string;
		};
		expect(response.status).toBe(200);
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

	it("reuses a matching stored attestation without another prepare POST", async () => {
		const [before] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		const posts = origin.preparePosts;
		const prepared = await prepareInstantFinishRevision(
			database,
			{
				videoId: videoId as never,
				editSpec: spec(8),
				baseGeneration: before?.generation ?? 0,
				draftVersion: (before?.latestDraftVersion ?? 0) + 1,
				draftSession: before?.draftSession || "editor",
			},
			{ origin: origin.client() },
		);
		expect(origin.preparePosts).toBe(posts + 1);
		const published = await publishInstantFinishRevision(
			database,
			{
				videoId: videoId as never,
				editSpec: spec(8),
				baseGeneration: before?.generation ?? 0,
				draftVersion: (before?.latestDraftVersion ?? 0) + 1,
				draftSession: before?.draftSession || "editor",
			},
			{ origin: origin.client() },
		);
		expect(origin.preparePosts).toBe(posts + 1);
		expect(published.revisionId).toBe(prepared.revisionId);
	});

	it("refuses a tampered stored attestation", async () => {
		const [before] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		const prepared = await prepareInstantFinishRevision(
			database,
			{
				videoId: videoId as never,
				editSpec: spec(9),
				baseGeneration: before?.generation ?? 0,
				draftVersion: (before?.latestDraftVersion ?? 0) + 1,
				draftSession: before?.draftSession || "editor",
			},
			{ origin: origin.client() },
		);
		await database
			.update(editRevision)
			.set({
				metadataSnapshot: {
					captionsVtt: "",
					chapters: [],
					summaryStatus: "persisted",
					summaryDerived: false,
					summaryText: null,
					thumbnail: "unavailable",
					durationSeconds: 1,
					attestationMac: "forged",
					attestationBody: '{"intentId":"x"}\n',
				},
			})
			.where(eq(editRevision.revisionId, prepared.revisionId));
		await expect(
			publishInstantFinishRevision(
				database,
				{
					videoId: videoId as never,
					editSpec: spec(9),
					baseGeneration: before?.generation ?? 0,
					draftVersion: (before?.latestDraftVersion ?? 0) + 1,
					draftSession: before?.draftSession || "editor",
				},
				{ origin: origin.client() },
			),
		).rejects.toThrow(/forged|attestation/i);
		const [after] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(after?.currentRevisionId).not.toBe(prepared.revisionId);
	});

	it("returns the current revision when a late prepare repeats the published spec", async () => {
		const specA = spec(1.5);
		const specB = spec(2.5);
		const [start] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		await publishInstantFinishRevision(
			database,
			{
				videoId: videoId as never,
				editSpec: specA,
				baseGeneration: start?.generation ?? 0,
				draftVersion: (start?.latestDraftVersion ?? 0) + 1,
				draftSession: start?.draftSession || "editor",
			},
			{ origin: origin.client() },
		);
		const [mid] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		const published = await publishInstantFinishRevision(
			database,
			{
				videoId: videoId as never,
				editSpec: specB,
				expectedEditSpec: specA,
				baseGeneration: mid?.generation ?? 0,
				draftVersion: (mid?.latestDraftVersion ?? 0) + 1,
				draftSession: mid?.draftSession || "editor",
			},
			{ origin: origin.client() },
		);
		const [after] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		const posts = origin.preparePosts;
		const prepared = await prepareInstantFinishRevision(
			database,
			{
				videoId: videoId as never,
				editSpec: specB,
				expectedEditSpec: specA,
				baseGeneration: after?.generation ?? 0,
				draftVersion: (after?.latestDraftVersion ?? 0) + 1,
				draftSession: after?.draftSession || "editor",
			},
			{ origin: origin.client() },
		);
		expect(prepared.success).toBe(true);
		expect(prepared.revisionId).toBe(published.revisionId);
		expect(origin.preparePosts).toBe(posts);
	});

	it("still rejects a different spec with a stale expectedEditSpec", async () => {
		const specA = spec(3.5);
		const specB = spec(4.5);
		const specC = spec(5.5);
		const [start] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		await publishInstantFinishRevision(
			database,
			{
				videoId: videoId as never,
				editSpec: specA,
				baseGeneration: start?.generation ?? 0,
				draftVersion: (start?.latestDraftVersion ?? 0) + 1,
				draftSession: start?.draftSession || "editor",
			},
			{ origin: origin.client() },
		);
		const [mid] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		await publishInstantFinishRevision(
			database,
			{
				videoId: videoId as never,
				editSpec: specB,
				expectedEditSpec: specA,
				baseGeneration: mid?.generation ?? 0,
				draftVersion: (mid?.latestDraftVersion ?? 0) + 1,
				draftSession: mid?.draftSession || "editor",
			},
			{ origin: origin.client() },
		);
		const [after] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		const posts = origin.preparePosts;
		await expect(
			prepareInstantFinishRevision(
				database,
				{
					videoId: videoId as never,
					editSpec: specC,
					expectedEditSpec: specA,
					baseGeneration: after?.generation ?? 0,
					draftVersion: (after?.latestDraftVersion ?? 0) + 1,
					draftSession: after?.draftSession || "editor",
				},
				{ origin: origin.client() },
			),
		).rejects.toThrow(/edited in another session/);
		expect(origin.preparePosts).toBe(posts);
	});

	it("restarts a stranded readback and does not let a stale readback revert a later current", async () => {
		const [before] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		origin.failCaptions = true;
		origin.artifactReads = 0;
		const stranded = await publishInstantFinishRevision(
			database,
			{
				videoId,
				editSpec: spec(7),
				baseGeneration: before?.generation ?? 0,
				draftVersion: (before?.latestDraftVersion ?? 0) + 1,
				draftSession: "editor",
			},
			{ origin: origin.client() },
		);
		expect(origin.artifactReads).toBe(0);
		origin.failCaptions = false;
		const later = await publishInstantFinishRevision(
			database,
			{
				videoId,
				editSpec: spec(8),
				baseGeneration: (before?.generation ?? 0) + 1,
				draftVersion: (before?.latestDraftVersion ?? 0) + 2,
				draftSession: "editor",
			},
			{ origin: origin.client() },
		);
		const swept = await sweepRevisionReadbacks(database, {
			origin: origin.client(),
		});
		expect(swept.some((row) => row.reason === "stale" && !row.reverted)).toBe(
			true,
		);
		const [after] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(after?.currentRevisionId).toBe(later.revisionId);
		expect(after?.currentRevisionId).not.toBe(stranded.revisionId);
	});

	it("does not let two workers process the same readback", async () => {
		const [before] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		const published = await publishInstantFinishRevision(
			database,
			{
				videoId,
				editSpec: spec(8.5),
				baseGeneration: before?.generation ?? 0,
				draftVersion: (before?.latestDraftVersion ?? 0) + 1,
				draftSession: "editor",
			},
			{ origin: origin.client() },
		);
		const [first, second] = await Promise.all([
			sweepRevisionReadbacks(database, {
				origin: origin.client(),
				workerId: "a",
				revisionId: published.revisionId,
			}),
			sweepRevisionReadbacks(database, {
				origin: origin.client(),
				workerId: "b",
				revisionId: published.revisionId,
			}),
		]);
		const processed = [...first, ...second].filter((row) => !row.skipped);
		expect(processed).toHaveLength(1);
	});

	it("does not revert a readback killed during its lease until the lease expires", async () => {
		const [before] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		const published = await publishInstantFinishRevision(
			database,
			{
				videoId,
				editSpec: spec(9),
				baseGeneration: before?.generation ?? 0,
				draftVersion: (before?.latestDraftVersion ?? 0) + 1,
				draftSession: "editor",
			},
			{ origin: origin.client() },
		);
		const claimedAt = new Date();
		const claimed = await claimRevisionReadback(database, {
			now: claimedAt,
			revisionId: published.revisionId,
			workerId: "killed",
		});
		expect(claimed?.leaseToken).toBeTruthy();
		origin.failCaptions = true;
		const duringLease = await sweepRevisionReadbacks(database, {
			origin: origin.client(),
			now: new Date(claimedAt.getTime() + 1_000),
			revisionId: published.revisionId,
			workerId: "other",
		});
		expect(duringLease.filter((row) => row.reverted)).toHaveLength(0);
		const [held] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(held?.currentRevisionId).toBe(published.revisionId);
		await database
			.update(revisionOutbox)
			.set({
				payload: sql`JSON_SET(payload, '$.leaseToken', 'replaced-token')`,
			})
			.where(eq(revisionOutbox.id, claimed?.id ?? 0));
		if (!claimed) throw new Error("readback was not claimed");
		const lost = await completeRevisionReadback(
			database,
			claimed,
			origin.client(),
			claimedAt,
		);
		expect(lost.reverted).toBe(false);
		expect(lost.reason).toBe("lease-lost");
		await database
			.update(revisionOutbox)
			.set({
				payload: sql`JSON_SET(payload, '$.leaseUntilMs', 1, '$.leaseUntil', '2000-01-01T00:00:00.000Z')`,
			})
			.where(eq(revisionOutbox.id, claimed?.id ?? 0));
		const expired = await sweepRevisionReadbacks(database, {
			origin: origin.client(),
			now: new Date(claimedAt.getTime() + 60_000),
			revisionId: published.revisionId,
			workerId: "after-expiry",
		});
		expect(expired.some((row) => row.reverted)).toBe(true);
		const [after] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(after?.currentRevisionId).toBe(before?.currentRevisionId);
		origin.failCaptions = false;
	});

	it("joins an in-flight prepare of the same spec instead of 409", async () => {
		const specS = spec(6.5);
		const [start] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		const input = {
			videoId: videoId as never,
			editSpec: specS,
			baseGeneration: start?.generation ?? 0,
			draftVersion: (start?.latestDraftVersion ?? 0) + 1,
			draftSession: start?.draftSession || "editor",
		};
		let releasePrepare: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releasePrepare = resolve;
		});
		const slow = origin.client();
		const original = slow.prepareRevision.bind(slow);
		slow.prepareRevision = async (body) => {
			await gate;
			return original(body);
		};
		const postsBefore = origin.preparePosts;
		const preparing = prepareInstantFinishRevision(database, input, {
			origin: slow,
		});
		await vi.waitFor(async () => {
			const rows = await database
				.select()
				.from(editRevision)
				.where(eq(editRevision.videoId, videoId as never));
			expect(rows.some((row) => row.state === "PREPARING")).toBe(true);
		});
		const publishing = publishInstantFinishRevision(database, input, {
			origin: origin.client(),
		});
		await vi.waitFor(async () => {
			const rows = await database
				.select()
				.from(editRevision)
				.where(eq(editRevision.videoId, videoId as never));
			expect(rows.some((row) => row.error === PUBLISH_JOINED_PREPARE)).toBe(
				true,
			);
		});
		releasePrepare();
		const published = await publishing;
		await preparing;
		expect(published.success).toBe(true);
		expect(origin.preparePosts).toBe(postsBefore + 1);
		const [after] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(after?.currentRevisionId).toBe(published.revisionId);
	}, 60_000);

	it("supersedes an in-flight prepare of a different spec instead of 409", async () => {
		const specS = spec(7.5);
		const specOther = spec(8.5);
		const [start] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		const base = {
			videoId: videoId as never,
			baseGeneration: start?.generation ?? 0,
			draftVersion: (start?.latestDraftVersion ?? 0) + 1,
			draftSession: start?.draftSession || "editor",
		};
		let releasePrepare: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releasePrepare = resolve;
		});
		const slow = origin.client();
		const original = slow.prepareRevision.bind(slow);
		slow.prepareRevision = async (body) => {
			await gate;
			return original(body);
		};
		const preparing = prepareInstantFinishRevision(
			database,
			{ ...base, editSpec: specOther },
			{ origin: slow },
		);
		let otherRevisionId = "";
		await vi.waitFor(async () => {
			const rows = await database
				.select()
				.from(editRevision)
				.where(eq(editRevision.videoId, videoId as never));
			const inflight = rows.find((row) => row.state === "PREPARING");
			expect(inflight).toBeTruthy();
			otherRevisionId = inflight?.revisionId ?? "";
		});
		const published = await publishInstantFinishRevision(
			database,
			{ ...base, editSpec: specS, draftVersion: base.draftVersion + 1 },
			{ origin: origin.client() },
		);
		releasePrepare();
		await preparing.catch(() => undefined);
		expect(published.success).toBe(true);
		const [after] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(after?.currentRevisionId).toBe(published.revisionId);
		const [other] = await database
			.select()
			.from(editRevision)
			.where(eq(editRevision.revisionId, otherRevisionId));
		expect(other?.state).not.toBe("CURRENT");
	}, 60_000);

	it("does not let a failed prepare block a new attempt", async () => {
		const specS = spec(8.25);
		const [start] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		const input = {
			videoId: videoId as never,
			editSpec: specS,
			baseGeneration: start?.generation ?? 0,
			draftVersion: (start?.latestDraftVersion ?? 0) + 1,
			draftSession: start?.draftSession || "editor",
		};
		const failing = origin.client();
		failing.prepareRevision = async () => {
			throw new Error("injected prepare failure");
		};
		await expect(
			prepareInstantFinishRevision(database, input, { origin: failing }),
		).rejects.toThrow(/injected prepare failure/);
		const published = await publishInstantFinishRevision(
			database,
			{ ...input, draftVersion: input.draftVersion + 1 },
			{ origin: origin.client() },
		);
		expect(published.success).toBe(true);
		const [after] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(after?.currentRevisionId).toBe(published.revisionId);
	});

	it("still rejects a different session and a non-adjacent generation", async () => {
		const [after] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		const session = after?.draftSession || "editor";
		await expect(
			publishInstantFinishRevision(
				database,
				{
					videoId: videoId as never,
					editSpec: spec(0.4),
					baseGeneration: (after?.generation ?? 1) - 1,
					draftVersion: (after?.latestDraftVersion ?? 0) + 1,
					draftSession: "other-session",
				},
				{ origin: origin.client() },
			),
		).rejects.toThrow(/generation/);
		await expect(
			publishInstantFinishRevision(
				database,
				{
					videoId: videoId as never,
					editSpec: spec(0.6),
					baseGeneration: (after?.generation ?? 0) + 5,
					draftVersion: (after?.latestDraftVersion ?? 0) + 1,
					draftSession: session,
				},
				{ origin: origin.client() },
			),
		).rejects.toThrow(/generation/);
	});

	it("rejects a second tab with a stale expectedEditSpec without advancing its draft", async () => {
		const specA = spec(7.25);
		const specB = spec(8.75);
		const [start] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		const session = start?.draftSession || "editor";
		await publishInstantFinishRevision(
			database,
			{
				videoId: videoId as never,
				editSpec: specA,
				baseGeneration: start?.generation ?? 0,
				draftVersion: (start?.latestDraftVersion ?? 0) + 1,
				draftSession: session,
			},
			{ origin: origin.client() },
		);
		const [mid] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		await publishInstantFinishRevision(
			database,
			{
				videoId: videoId as never,
				editSpec: specB,
				expectedEditSpec: specA,
				baseGeneration: mid?.generation ?? 0,
				draftVersion: (mid?.latestDraftVersion ?? 0) + 1,
				draftSession: session,
			},
			{ origin: origin.client() },
		);
		const [after] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		await expect(
			publishInstantFinishRevision(
				database,
				{
					videoId: videoId as never,
					editSpec: specB,
					expectedEditSpec: specA,
					baseGeneration: after?.generation ?? 0,
					draftVersion: (after?.latestDraftVersion ?? 0) + 4,
					draftSession: "other-tab",
				},
				{ origin: origin.client() },
			),
		).rejects.toThrow(/edited in another session/);
		const [unchanged] = await database
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never));
		expect(unchanged?.draftSession).toBe(after?.draftSession);
		expect(unchanged?.latestDraftVersion).toBe(after?.latestDraftVersion);
		expect(unchanged?.currentRevisionId).toBe(after?.currentRevisionId);
	});
});

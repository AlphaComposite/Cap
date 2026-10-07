import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { videos, videoUploads } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import mysql from "mysql2/promise";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.example.com" },
	serverEnv: () => ({
		MEDIA_SERVER_URL: "https://worker.example.com",
		MEDIA_SERVER_WEBHOOK_SECRET: "media-secret",
		MEDIA_SERVER_WEBHOOK_URL: "https://cap.example.com",
		WEB_URL: "https://cap.example.com",
	}),
}));

import { db } from "@cap/database";
import { POST } from "@/app/api/webhooks/media-server/progress/route";
import { saveMetadataAndComplete } from "@/workflows/process-video";

const ownerId = "owner57correct1";
const orgId = "org57correct001";
const callbackVideoId = "cap59lock000001";
const siblingVideoId = "cap59lock000002";
const replacedVideoId = "cap59lock000003";
const workflowVideoId = "cap59lock000004";
const workflowSiblingId = "cap59lock000005";
const fixtureIds = [
	callbackVideoId,
	siblingVideoId,
	replacedVideoId,
	workflowVideoId,
	workflowSiblingId,
];
const barrierLock = "cap59lock_barrier";
const triggerName = "cap59lock_upload_barrier";
const fixtureDir = process.env.CAP_TEST_FIXTURE_DIR;
const evidencePath = path.join(fixtureDir ?? ".", "red-callback-deadlock.log");
const workflowEvidencePath = path.join(
	fixtureDir ?? ".",
	"red-workflow-deadlock.log",
);
const replacedPath = path.join(fixtureDir ?? ".", "replaced-after-wait.log");

const metadata = {
	duration: 12.5,
	width: 320,
	height: 240,
	fps: 30,
	videoCodec: "h264",
	audioCodec: "aac",
	audioChannels: 2,
	sampleRate: 48000,
	bitrate: 1_000_000,
	fileSize: 4096,
};

function regressionUrl() {
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
	process.env.CAP_WIRE_A_DATABASE_URL = databaseUrl;
	process.env.DATABASE_URL = databaseUrl;
	delete process.env.CAP_INSTANT_FINISH_OWNERS;
}

function errnoOf(error: unknown) {
	if (!error || typeof error !== "object" || !("errno" in error)) return null;
	return typeof error.errno === "number" ? error.errno : null;
}

function codeOf(error: unknown) {
	if (!error || typeof error !== "object" || !("code" in error)) return null;
	return typeof error.code === "string" ? error.code : null;
}

async function seed(conn: mysql.Connection, videoId: string, rawKey: string) {
	await conn.query(
		"INSERT INTO videos (id, ownerId, orgId, name, source, width, height, fps, createdAt, updatedAt) VALUES (?, ?, ?, ?, JSON_OBJECT('type', 'webMP4'), NULL, NULL, NULL, NOW(3), NOW(3))",
		[videoId, ownerId, orgId, videoId],
	);
	await conn.query(
		"INSERT INTO video_uploads (video_id, uploaded, total, phase, processing_progress, raw_file_key, recovery_claim_id) VALUES (?, 1, 1, 'processing', 10, ?, NULL)",
		[videoId, rawKey],
	);
}

async function cleanup(conn: mysql.Connection) {
	const marks = fixtureIds.map(() => "?").join(", ");
	await conn.query(
		`DELETE FROM outbox WHERE videoId IN (${marks})`,
		fixtureIds,
	);
	await conn.query(
		`DELETE FROM video_uploads WHERE video_id IN (${marks})`,
		fixtureIds,
	);
	await conn.query(`DELETE FROM videos WHERE id IN (${marks})`, fixtureIds);
}

async function installBarrier(conn: mysql.Connection) {
	await conn.query(`DROP TRIGGER IF EXISTS ${triggerName}`);
	await conn.query(
		`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON video_uploads FOR EACH ROW SET @cap59lock_wait = IF(NEW.video_id LIKE 'cap59lock%', GET_LOCK('${barrierLock}', 8) + RELEASE_LOCK('${barrierLock}'), 0)`,
	);
}

async function dropBarrier(conn: mysql.Connection) {
	await conn.query(`DROP TRIGGER IF EXISTS ${triggerName}`);
	await conn.query("SELECT RELEASE_LOCK(?)", [barrierLock]);
}

async function lockSnapshot(conn: mysql.Connection) {
	const [locks] = await conn.query(
		"SELECT OBJECT_NAME, LOCK_TYPE, LOCK_MODE, LOCK_STATUS FROM performance_schema.data_locks WHERE OBJECT_SCHEMA = ? AND OBJECT_NAME IN ('videos', 'video_uploads') AND LOCK_TYPE = 'RECORD'",
		["cap57_test_regression"],
	);
	const [processlist] = await conn.query(
		"SELECT id, state, time, LEFT(COALESCE(info, ''), 180) AS info FROM information_schema.processlist WHERE db = ? OR state LIKE '%lock%'",
		["cap57_test_regression"],
	);
	return { locks, processlist };
}

async function waitForUploadBarrier(conn: mysql.Connection) {
	const started = Date.now();
	while (Date.now() - started < 6_000) {
		const snapshot = await lockSnapshot(conn);
		const waiting = (
			snapshot.processlist as Array<{ state: string | null }>
		).some((row) => (row.state ?? "").includes("User lock"));
		const holdsUpload = (
			snapshot.locks as Array<{ OBJECT_NAME: string; LOCK_MODE: string }>
		).some(
			(row) =>
				row.OBJECT_NAME === "video_uploads" && row.LOCK_MODE.includes("X"),
		);
		if (waiting && holdsUpload) return snapshot;
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
	return null;
}

async function deadlockSection(conn: mysql.Connection) {
	const [rows] = await conn.query("SHOW ENGINE INNODB STATUS");
	const status = String((rows as Array<{ Status?: string }>)[0]?.Status ?? "");
	const start = status.indexOf("LATEST DETECTED DEADLOCK");
	if (start < 0) return "NO_LATEST_DETECTED_DEADLOCK";
	return status.slice(start, start + 3500);
}

function postComplete(videoId: string) {
	return POST(
		new NextRequest(
			"https://cap.example.com/api/webhooks/media-server/progress",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-media-server-secret": "media-secret",
				},
				body: JSON.stringify({
					jobId: "job-not-identity",
					videoId,
					phase: "complete",
					progress: 100,
					metadata,
				}),
			},
		),
	);
}

describe.skipIf(!fixtureDir)("webMP4 completion lock order", () => {
	let admin: mysql.Connection;

	beforeAll(async () => {
		for (const id of [ownerId, orgId, ...fixtureIds]) {
			if (id.length !== 15) throw new Error(`fixture id length ${id.length}`);
		}
		admin = await mysql.createConnection(databaseUrl);
		const [selected] = await admin.query("SELECT DATABASE() AS db");
		const dbName = String((selected as Array<{ db: string }>)[0]?.db ?? "");
		if (dbName !== "cap57_test_regression") {
			throw new Error(`connected to ${dbName}`);
		}
		await cleanup(admin);
		await installBarrier(admin);
	}, 60_000);

	afterAll(async () => {
		if (!admin) return;
		await dropBarrier(admin).catch(() => undefined);
		await cleanup(admin).catch(() => undefined);
		await admin.end();
	}, 60_000);

	it("does not cycle when parent-first replacement meets completion", async () => {
		const rawKey = `${ownerId}/${callbackVideoId}/raw.mp4`;
		const siblingKey = `${ownerId}/${siblingVideoId}/raw.mp4`;
		await seed(admin, callbackVideoId, rawKey);
		await seed(admin, siblingVideoId, siblingKey);
		const holder = await mysql.createConnection(databaseUrl);
		const parent = await mysql.createConnection(databaseUrl);
		const observer = await mysql.createConnection(databaseUrl);
		let postStatus: number | null = null;
		let postError: unknown = null;
		let acquired = false;
		let parentError: unknown = null;
		let paused: Awaited<ReturnType<typeof lockSnapshot>> | null = null;
		try {
			await holder.query("SELECT GET_LOCK(?, 2)", [barrierLock]);
			const pending = postComplete(callbackVideoId).then(
				(response) => {
					postStatus = response.status;
				},
				(error: unknown) => {
					postError = error;
				},
			);
			paused = await waitForUploadBarrier(observer);
			expect(
				paused,
				"callback did not pause after the upload row lock",
			).not.toBeNull();
			await parent.query("SET SESSION innodb_lock_wait_timeout = 2");
			await parent.beginTransaction();
			try {
				await parent.query("SELECT id FROM videos WHERE id = ? FOR UPDATE", [
					callbackVideoId,
				]);
				acquired = true;
			} catch (error) {
				parentError = error;
				await parent.rollback();
			}
			if (acquired) {
				const deleting = parent
					.query("DELETE FROM video_uploads WHERE video_id = ?", [
						callbackVideoId,
					])
					.then(
						async () => {
							await parent.query("UPDATE videos SET width = 999 WHERE id = ?", [
								callbackVideoId,
							]);
							await parent.commit();
						},
						async (error: unknown) => {
							parentError = error;
							await parent.rollback().catch(() => undefined);
						},
					);
				await new Promise((resolve) => setTimeout(resolve, 200));
				await holder.query("SELECT RELEASE_LOCK(?)", [barrierLock]);
				await deleting;
			} else {
				await holder.query("SELECT RELEASE_LOCK(?)", [barrierLock]);
			}
			await pending;
			const section = await deadlockSection(observer);
			const sawDeadlock =
				errnoOf(parentError) === 1213 ||
				codeOf(parentError) === "ER_LOCK_DEADLOCK" ||
				postStatus === 500 ||
				section.includes("DEADLOCK");
			if (acquired || sawDeadlock) {
				writeFileSync(
					evidencePath,
					[
						"method: POST retainGenericWebMp4Completion via upload-update GET_LOCK barrier",
						`acquiredVideoWhileCallbackHeldUpload: ${acquired}`,
						`parentErrno: ${errnoOf(parentError)}`,
						`parentCode: ${codeOf(parentError)}`,
						`postStatus: ${postStatus}`,
						`postError: ${postError instanceof Error ? postError.message : String(postError)}`,
						"pausedLocks:",
						JSON.stringify(paused, null, 2),
						"innodb:",
						section,
						"",
					].join("\n"),
				);
			}
			expect(acquired).toBe(false);
			expect(errnoOf(parentError)).toBe(1205);
			expect(postStatus).toBe(200);
			const [upload] = await db()
				.select({
					phase: videoUploads.phase,
					progress: videoUploads.processingProgress,
					rawFileKey: videoUploads.rawFileKey,
					claim: videoUploads.recoveryClaimId,
				})
				.from(videoUploads)
				.where(eq(videoUploads.videoId, callbackVideoId as never));
			expect(upload).toMatchObject({
				phase: "processing",
				progress: 100,
				rawFileKey: rawKey,
				claim: null,
			});
			const [video] = await db()
				.select({ width: videos.width })
				.from(videos)
				.where(eq(videos.id, callbackVideoId as never));
			expect(video?.width).toBe(320);
			const [sibling] = await db()
				.select({
					width: videos.width,
					phase: videoUploads.phase,
					progress: videoUploads.processingProgress,
					rawFileKey: videoUploads.rawFileKey,
				})
				.from(videos)
				.innerJoin(videoUploads, eq(videoUploads.videoId, videos.id))
				.where(eq(videos.id, siblingVideoId as never));
			expect(sibling).toMatchObject({
				width: null,
				phase: "processing",
				progress: 10,
				rawFileKey: siblingKey,
			});
		} finally {
			await holder
				.query("SELECT RELEASE_LOCK(?)", [barrierLock])
				.catch(() => undefined);
			await parent.rollback().catch(() => undefined);
			await holder.end();
			await parent.end();
			await observer.end();
			await cleanup(admin);
		}
	}, 25_000);

	it("documents the preexisting payload limitation when replacement commits before completion locks", async () => {
		const originalKey = `${ownerId}/${replacedVideoId}/raw.mp4`;
		const replacementKey = `${ownerId}/${replacedVideoId}/replacement.mp4`;
		await seed(admin, replacedVideoId, originalKey);
		const parent = await mysql.createConnection(databaseUrl);
		try {
			await parent.query("SET SESSION innodb_lock_wait_timeout = 5");
			await parent.beginTransaction();
			await parent.query("SELECT id FROM videos WHERE id = ? FOR UPDATE", [
				replacedVideoId,
			]);
			const pending = postComplete(replacedVideoId);
			const started = Date.now();
			let waiting = false;
			while (Date.now() - started < 5_000) {
				const [rows] = await admin.query(
					"SELECT OBJECT_NAME FROM performance_schema.data_locks WHERE OBJECT_SCHEMA = ? AND OBJECT_NAME = 'videos' AND LOCK_STATUS = 'WAITING'",
					["cap57_test_regression"],
				);
				waiting = (rows as unknown[]).length > 0;
				if (waiting) break;
				await new Promise((resolve) => setTimeout(resolve, 40));
			}
			expect(waiting).toBe(true);
			await parent.query("UPDATE videos SET width = 999 WHERE id = ?", [
				replacedVideoId,
			]);
			await parent.query("DELETE FROM video_uploads WHERE video_id = ?", [
				replacedVideoId,
			]);
			await parent.query(
				"INSERT INTO video_uploads (video_id, uploaded, total, phase, processing_progress, raw_file_key, recovery_claim_id) VALUES (?, 1, 1, 'processing', 4, ?, NULL)",
				[replacedVideoId, replacementKey],
			);
			await parent.commit();
			const response = await pending;
			const [video] = await db()
				.select({ width: videos.width })
				.from(videos)
				.where(eq(videos.id, replacedVideoId as never));
			const [upload] = await db()
				.select({
					rawFileKey: videoUploads.rawFileKey,
					progress: videoUploads.processingProgress,
					phase: videoUploads.phase,
				})
				.from(videoUploads)
				.where(eq(videoUploads.videoId, replacedVideoId as never));
			writeFileSync(
				replacedPath,
				[
					"caller snapshot key is not job identity; no schema/job id added",
					`postStatus: ${response.status}`,
					`width: ${video?.width ?? "null"}`,
					`rawFileKey: ${upload?.rawFileKey ?? "null"}`,
					`progress: ${upload?.progress ?? "null"}`,
					`phase: ${upload?.phase ?? "null"}`,
					"",
				].join("\n"),
			);
			expect(response.status).toBe(200);
			expect(upload?.rawFileKey).toBe(replacementKey);
			expect(upload?.phase).toBe("processing");
			expect(upload?.progress).toBe(100);
			expect(video?.width).toBe(320);
		} finally {
			await parent.rollback().catch(() => undefined);
			await parent.end();
			await cleanup(admin);
		}
	}, 20_000);

	it("does not cycle when parent-first replacement meets normal workflow save", async () => {
		const rawKey = `${ownerId}/${workflowVideoId}/raw.mp4`;
		const siblingKey = `${ownerId}/${workflowSiblingId}/raw.mp4`;
		await seed(admin, workflowVideoId, rawKey);
		await seed(admin, workflowSiblingId, siblingKey);
		const holder = await mysql.createConnection(databaseUrl);
		const parent = await mysql.createConnection(databaseUrl);
		const observer = await mysql.createConnection(databaseUrl);
		let saveError: unknown = null;
		let acquired = false;
		let parentError: unknown = null;
		let paused: Awaited<ReturnType<typeof lockSnapshot>> | null = null;
		try {
			await holder.query("SELECT GET_LOCK(?, 2)", [barrierLock]);
			const pending = saveMetadataAndComplete(
				workflowVideoId,
				rawKey,
				undefined,
				{ duration: 12.5, width: 640, height: 360, fps: 24 },
				ownerId,
			).then(
				() => undefined,
				(error: unknown) => {
					saveError = error;
				},
			);
			paused = await waitForUploadBarrier(observer);
			expect(
				paused,
				"workflow save did not pause after the upload row lock",
			).not.toBeNull();
			await parent.query("SET SESSION innodb_lock_wait_timeout = 2");
			await parent.beginTransaction();
			try {
				await parent.query("SELECT id FROM videos WHERE id = ? FOR UPDATE", [
					workflowVideoId,
				]);
				acquired = true;
			} catch (error) {
				parentError = error;
				await parent.rollback();
			}
			if (acquired) {
				const deleting = parent
					.query("DELETE FROM video_uploads WHERE video_id = ?", [
						workflowVideoId,
					])
					.then(
						async () => {
							await parent.query("UPDATE videos SET width = 999 WHERE id = ?", [
								workflowVideoId,
							]);
							await parent.commit();
						},
						async (error: unknown) => {
							parentError = error;
							await parent.rollback().catch(() => undefined);
						},
					);
				await new Promise((resolve) => setTimeout(resolve, 200));
				await holder.query("SELECT RELEASE_LOCK(?)", [barrierLock]);
				await deleting;
			} else {
				await holder.query("SELECT RELEASE_LOCK(?)", [barrierLock]);
			}
			await pending;
			const section = await deadlockSection(observer);
			const sawDeadlock =
				errnoOf(parentError) === 1213 ||
				codeOf(parentError) === "ER_LOCK_DEADLOCK" ||
				errnoOf(saveError) === 1213 ||
				section.includes("DEADLOCK");
			if (acquired || sawDeadlock) {
				writeFileSync(
					workflowEvidencePath,
					[
						"method: exported saveMetadataAndComplete normal transaction, unchanged SQL, upload-update GET_LOCK barrier",
						`acquiredVideoWhileSaveHeldUpload: ${acquired}`,
						`parentErrno: ${errnoOf(parentError)}`,
						`parentCode: ${codeOf(parentError)}`,
						`saveErrno: ${errnoOf(saveError)}`,
						`saveError: ${saveError instanceof Error ? saveError.message : String(saveError)}`,
						"pausedLocks:",
						JSON.stringify(paused, null, 2),
						"innodb:",
						section,
						"",
					].join("\n"),
				);
			}
			expect(acquired).toBe(false);
			expect(errnoOf(parentError)).toBe(1205);
			expect(saveError).toBeNull();
			const [upload] = await db()
				.select({
					phase: videoUploads.phase,
					rawFileKey: videoUploads.rawFileKey,
					claim: videoUploads.recoveryClaimId,
				})
				.from(videoUploads)
				.where(eq(videoUploads.videoId, workflowVideoId as never));
			expect(upload).toMatchObject({
				phase: "processing",
				rawFileKey: rawKey,
				claim: null,
			});
			const [video] = await db()
				.select({ width: videos.width })
				.from(videos)
				.where(eq(videos.id, workflowVideoId as never));
			expect(video?.width).toBe(640);
			const [sibling] = await db()
				.select({
					width: videos.width,
					phase: videoUploads.phase,
					progress: videoUploads.processingProgress,
					rawFileKey: videoUploads.rawFileKey,
				})
				.from(videos)
				.innerJoin(videoUploads, eq(videoUploads.videoId, videos.id))
				.where(eq(videos.id, workflowSiblingId as never));
			expect(sibling).toMatchObject({
				width: null,
				phase: "processing",
				progress: 10,
				rawFileKey: siblingKey,
			});
		} finally {
			await holder
				.query("SELECT RELEASE_LOCK(?)", [barrierLock])
				.catch(() => undefined);
			await parent.rollback().catch(() => undefined);
			await holder.end();
			await parent.end();
			await observer.end();
			await cleanup(admin);
		}
	}, 25_000);
});

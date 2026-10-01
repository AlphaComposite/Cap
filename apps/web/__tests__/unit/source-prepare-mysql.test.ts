import path from "node:path";
import { fileURLToPath } from "node:url";
import { revisionOutbox, videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	enqueueSourcePrepare,
	SOURCE_PREPARE_JOB,
	sweepSourcePrepare,
} from "@/lib/source-prepare";

const databaseUrl = process.env.CAP_WIRE_A_DATABASE_URL;
const ownerId = "owner57correct1";
const videoA = "v57corr0000001";
const videoB = "v57corr0000002";
const videoC = "v57corr0000003";
const videosUnderTest = [videoA, videoB, videoC];
const migrationsFolder = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../packages/database/migrations",
);

describe.skipIf(!databaseUrl)("source prepare mysql lease", () => {
	let pool: mysql.Pool;

	beforeAll(async () => {
		pool = mysql.createPool(databaseUrl ?? "");
		const database = drizzle(pool);
		await migrate(database, { migrationsFolder });
		await pool.query(
			"DELETE FROM outbox WHERE videoId IN (?, ?, ?)",
			videosUnderTest,
		);
		await pool.query(
			"DELETE FROM videos WHERE id IN (?, ?, ?)",
			videosUnderTest,
		);
		for (const id of videosUnderTest) {
			await database.insert(videos).values({
				id: id as never,
				ownerId: ownerId as never,
				orgId: "org57correct001" as never,
				source: { type: "webMP4" },
				duration: 12,
			});
		}
	}, 120_000);

	afterAll(async () => {
		await pool.query(
			"DELETE FROM outbox WHERE videoId IN (?, ?, ?)",
			videosUnderTest,
		);
		await pool.query(
			"DELETE FROM videos WHERE id IN (?, ?, ?)",
			videosUnderTest,
		);
		await pool.end();
	});

	it("waits for the parent video-row lock before inserting", async () => {
		const hold = await mysql.createConnection(databaseUrl ?? "");
		try {
			await hold.beginTransaction();
			await hold.query("SELECT id FROM videos WHERE id = ? FOR UPDATE", [
				videoA,
			]);
			const database = drizzle(pool);
			let finished = false;
			const pending = enqueueSourcePrepare(database as never, {
				videoId: videoA,
				ownerId,
				sourceObjectKey: `${ownerId}/${videoA}/result.mp4`,
				env: { CAP_INSTANT_FINISH_OWNERS: ownerId },
			}).finally(() => {
				finished = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(finished).toBe(false);
			await hold.commit();
			await pending;
		} finally {
			await hold.rollback().catch(() => undefined);
			await hold.end();
		}
	});

	it("keeps one job when two verified-ready enqueues race", async () => {
		const database = drizzle(pool);
		const input = {
			videoId: videoC,
			ownerId,
			sourceObjectKey: `${ownerId}/${videoC}/result.mp4`,
			env: { CAP_INSTANT_FINISH_OWNERS: ownerId },
		};
		await Promise.all([
			enqueueSourcePrepare(database as never, input),
			enqueueSourcePrepare(database as never, input),
		]);
		const [rows] = await pool.query(
			"SELECT id FROM outbox WHERE videoId = ? AND job = ?",
			[videoC, SOURCE_PREPARE_JOB],
		);
		expect(rows).toHaveLength(1);
	});

	it("does not let a stale claimant delete the successor job", async () => {
		const database = drizzle(pool);
		await pool.query("DELETE FROM outbox WHERE job = ?", [SOURCE_PREPARE_JOB]);
		const inserted = await enqueueSourcePrepare(database as never, {
			videoId: videoB,
			ownerId,
			sourceObjectKey: `${ownerId}/${videoB}/result.mp4`,
			env: { CAP_INSTANT_FINISH_OWNERS: ownerId },
		});
		expect(inserted).toBe("inserted");
		let claimToken = "";
		await sweepSourcePrepare(database as never, {
			load: async () => {
				const [before] = await pool.query(
					"SELECT JSON_UNQUOTE(JSON_EXTRACT(payload, '$.leaseToken')) AS token FROM outbox WHERE videoId = ?",
					[videoB],
				);
				claimToken = String(
					(before as { token: string | null }[])[0]?.token ?? "",
				);
				await pool.query(
					"UPDATE outbox SET payload = JSON_SET(payload, '$.leaseToken', 'successor') WHERE videoId = ?",
					[videoB],
				);
				return {
					videoId: videoB,
					ownerId,
					sourceObjectKey: `${ownerId}/${videoB}/result.mp4`,
					stableKey: `private/source/${videoB}/original`,
					flagged: true,
					currentRevisionId: "rev-b",
					currentIsIdentity: true,
					currentReadable: true,
					hasUserEdit: false,
					relocated: true,
					registeredPrivateKey: `private/source/${videoB}/original`,
					publicResultEligible: false,
					sourceIndexed: true,
					bindMatches: true,
					transcriptReady: false,
					captionsClaimed: true,
				};
			},
			effects: {
				copyStable: async () => ({ sha256: "a".repeat(64), skipped: true }),
				prepare: async () => ({ encoded: false, sha256: "a".repeat(64) }),
				publishIdentity: async () => ({ revisionId: "rev-b" }),
				relocateOriginal: async () => undefined,
				completeInventory: async () => undefined,
				refreshCaptions: async () => "ready" as const,
			},
		});
		expect(claimToken.length).toBeGreaterThan(8);
		const [rows] = await pool.query(
			"SELECT JSON_UNQUOTE(JSON_EXTRACT(payload, '$.leaseToken')) AS token FROM outbox WHERE videoId = ? AND job = ?",
			[videoB, SOURCE_PREPARE_JOB],
		);
		expect(rows).toEqual([{ token: "successor" }]);
		expect(eq(revisionOutbox.job, SOURCE_PREPARE_JOB)).toBeTruthy();
	});
});

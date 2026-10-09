import * as Db from "@cap/database/schema";
import { Database } from "@cap/web-backend/src/Database";
import { OrganisationsRepo } from "@cap/web-backend/src/Organisations/OrganisationsRepo";
import { SpacesRepo } from "@cap/web-backend/src/Spaces/SpacesRepo";
import { Storage } from "@cap/web-backend/src/Storage";
import { Tinybird } from "@cap/web-backend/src/Tinybird";
import { Videos } from "@cap/web-backend/src/Videos";
import { VideosPolicy } from "@cap/web-backend/src/Videos/VideosPolicy";
import { VideosRepo } from "@cap/web-backend/src/Videos/VideosRepo";
import { VideosRpcsLive } from "@cap/web-backend/src/Videos/VideosRpcs";
import {
	CurrentUser,
	DatabaseError,
	Organisation,
	User,
	Video,
} from "@cap/web-domain";
import { Headers } from "@effect/platform";
import { eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { Effect, Layer } from "effect";
import { createPool } from "mysql2/promise";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const state = vi.hoisted(() => ({
	database: undefined as any,
	owner: "stuck_owner",
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({ db: () => state.database }));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://127.0.0.1:32320" },
	serverEnv: () => ({ NEXTAUTH_SECRET: "upload-progress-test-only" }),
}));
vi.mock("@cap/web-backend/src/Auth.ts", () => ({
	provideOptionalAuth: <A>(effect: A) => effect,
}));
vi.mock("@cap/web-backend", () => ({
	Videos,
	Storage,
	makeCurrentUserLayer: vi.fn(),
}));
vi.mock("@cap/database/emails/config", () => ({ sendEmail: vi.fn() }));
vi.mock("@cap/database/emails/first-shareable-link", () => ({
	FirstShareableLink: vi.fn(),
}));
vi.mock("@/lib/live-transcribe", () => ({
	maybeStartLiveTranscription: vi.fn(),
}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/google-drive-storage-quota", () => ({
	invalidateGoogleDriveStorageQuotaCache: vi.fn(),
}));
vi.mock("../../app/api/utils", () => ({
	withAuth: async (c: any, next: () => Promise<void>) => {
		c.set("user", { id: state.owner });
		await next();
	},
}));

const url = process.env.CAP_UPLOAD_PROGRESS_MYSQL;
if (url) {
	const target = new URL(url);
	if (
		target.hostname !== "127.0.0.1" ||
		target.port !== "32316" ||
		target.pathname !== "/cap_stuck_progress"
	)
		throw new Error(
			"upload progress test requires owned capb2 loopback schema cap_stuck_progress",
		);
}
const videoId = Video.VideoId.make("stuck_video");
const ownerId = User.UserId.make("stuck_owner");
const total = 2876151;
const newer = new Date("2026-10-09T21:33:03Z");
const older = new Date("2026-10-09T21:32:50Z");
let pool: ReturnType<typeof createPool>;
let database: MySql2Database<typeof Db>;
let desktop: typeof import("../../app/api/desktop/[...route]/video").app;
let afterRead: (() => Promise<void>) | undefined;

function dependencies() {
	const repos = Layer.mergeAll(
		Layer.mock(Database, {
			_tag: "Database",
			use: (cb) =>
				Effect.tryPromise({
					try: async () => {
						const result = await cb(database as any);
						const hook = afterRead;
						afterRead = undefined;
						if (hook) await hook();
						return result;
					},
					catch: (cause) => new DatabaseError({ cause }),
				}),
		}),
		Layer.mock(VideosRepo, { _tag: "VideosRepo" }),
		Layer.mock(OrganisationsRepo, { _tag: "OrganisationsRepo" }),
		Layer.mock(SpacesRepo, { _tag: "SpacesRepo" }),
		Layer.mock(Storage, { _tag: "Storage" }),
		Layer.mock(Tinybird, { _tag: "Tinybird", enabled: false }),
	);
	return Layer.merge(
		repos,
		VideosPolicy.DefaultWithoutDependencies.pipe(Layer.provide(repos)),
	);
}

async function progress(
	path: "rpc" | "desktop",
	uploaded: number,
	updatedAt = newer,
) {
	if (path === "desktop") {
		const response = await desktop.request("/progress", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId,
				uploaded,
				total,
				updatedAt: updatedAt.toISOString(),
			}),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toBe(true);
		return;
	}
	const result = await Effect.runPromise(
		Effect.gen(function* () {
			const handle = yield* Video.VideoRpcs.accessHandler(
				"VideoUploadProgressUpdate",
			);
			return yield* handle(
				{ videoId, uploaded, total, updatedAt },
				Headers.empty,
			);
		}).pipe(
			Effect.provide(VideosRpcsLive),
			Effect.provide(Videos.DefaultWithoutDependencies),
			Effect.provide(dependencies()),
			Effect.provideService(CurrentUser, {
				id: User.UserId.make(state.owner),
			} as CurrentUser["Type"]),
			Effect.scoped,
		),
	);
	expect(result).toBe(true);
}
const rows = () =>
	database
		.select()
		.from(Db.videoUploads)
		.where(eq(Db.videoUploads.videoId, videoId));
const cleanup = () =>
	database.delete(Db.videoUploads).where(eq(Db.videoUploads.videoId, videoId));

// Tables are cloned from the capb2 schema by the runner, never from production.
describe.skipIf(!url)("real upload progress handlers / MySQL", () => {
	beforeAll(async () => {
		pool = createPool(url!);
		database = drizzle(pool, { schema: Db, mode: "default" });
		state.database = database;
		desktop = (await import("../../app/api/desktop/[...route]/video")).app;
	});
	afterAll(async () => {
		if (pool) await pool.end();
	});
	beforeEach(async () => {
		afterRead = undefined;
		state.owner = ownerId;
		await database.delete(Db.videoUploads);
		await database.delete(Db.videos);
		await database.insert(Db.videos).values({
			id: videoId,
			ownerId,
			orgId: Organisation.OrganisationId.make("stuck_org"),
			source: { type: "webMP4" },
		});
		await database.insert(Db.videoUploads).values({
			videoId,
			mode: "multipart",
			uploaded: 0,
			total,
			updatedAt: older,
		});
	});

	for (const path of ["rpc", "desktop"] as const) {
		it(`${path}: updates active uploads and ignores older progress`, async () => {
			await progress(path, 1000);
			await progress(path, 1, older);
			expect((await rows())[0]).toMatchObject({
				uploaded: 1000,
				total,
				mode: "multipart",
				phase: "uploading",
			});
		});
		it(`${path}: final byte count does not delete processing multipart state`, async () => {
			await database
				.update(Db.videoUploads)
				.set({ phase: "processing", rawFileKey: "fixture/raw-upload.mp4" })
				.where(eq(Db.videoUploads.videoId, videoId));
			await progress(path, total);
			expect((await rows())[0]).toMatchObject({
				uploaded: total,
				mode: "multipart",
				phase: "processing",
				rawFileKey: "fixture/raw-upload.mp4",
			});
		});
		for (const uploaded of [total, total - 1]) {
			it(`${path}: no resurrection after processing cleanup (${uploaded} bytes)`, async () => {
				await database
					.update(Db.videos)
					.set({
						source: { type: "webMP4", outputKey: "private/fixture/result.mp4" },
						transcriptionStatus: "COMPLETE",
					})
					.where(eq(Db.videos.id, videoId));
				await cleanup();
				await progress(path, uploaded);
				expect(await rows()).toEqual([]);
			});
			it(`${path}: no resurrection after singlepart cleanup (${uploaded} bytes)`, async () => {
				// Singlepart completion can delete the row before an outputKey exists.
				await cleanup();
				await progress(path, uploaded);
				expect(await rows()).toEqual([]);
			});
		}
		it(`${path}: missing video and non-owner cannot mutate progress`, async () => {
			state.owner = "another_owner";
			await expect(progress(path, total - 1)).rejects.toBeDefined();
			expect((await rows())[0]?.uploaded).toBe(0);
			state.owner = ownerId;
			await cleanup();
			await database.delete(Db.videos);
			await expect(progress(path, total - 1)).rejects.toBeDefined();
			expect(await rows()).toEqual([]);
		});
	}
	it("rpc: cleanup between progress read and write stays deleted", async () => {
		afterRead = async () => {
			await cleanup();
		};
		await progress("rpc", total - 1);
		expect(await rows()).toEqual([]);
	});
});

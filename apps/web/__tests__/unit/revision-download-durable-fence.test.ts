import { getTableName, type Table } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transfer = vi.hoisted(() => ({
	calls: 0,
	failed: false,
	hlsFailed: false,
	hlsCalls: 0,
	localReady: false,
	wait: null as Promise<void> | null,
	hlsWait: null as Promise<void> | null,
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({ db: () => ({}) }));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}), buildEnv: {} }));
vi.mock("@/lib/revision-media-grant", () => ({
	readArtifactReady: async () => transfer.localReady,
}));
vi.mock("@/lib/instant-finish-source-relocate", () => ({
	runtimeS3Client: vi.fn(),
}));
vi.mock("@/lib/revision-download-artifact", async (original) => ({
	...(await original<typeof import("@/lib/revision-download-artifact")>()),
	persistRevisionDownload: async (input: { includeHls?: unknown }) => {
		transfer.calls += 1;
		await transfer.wait;
		if (transfer.failed) throw new Error("ReadbackFailed");
		if (input.includeHls && transfer.hlsFailed)
			throw new Error("ThumbnailUnavailable");
		return input.includeHls ? receipt : { ...receipt, hls: undefined };
	},
	persistRevisionHls: async () => {
		transfer.hlsCalls += 1;
		await transfer.hlsWait;
		if (transfer.hlsFailed) throw new Error("ThumbnailUnavailable");
		return receipt.hls;
	},
}));

import type { DownloadReceipt } from "@/lib/revision-download-artifact";
import {
	pendingRevisionDownloads,
	sweepRevisionDownloads as startSweep,
	drainRevisionDownloads as sweepRevisionDownloads,
} from "@/lib/revision-download-job";

const dialect = new MySqlDialect();
const identity = {
	ownerId: "owner1234",
	videoId: "video1234",
	revisionId: "revision1234",
	generation: 7,
	sourceId: "source1234",
};
const receipt: DownloadReceipt = {
	...identity,
	validation: "verified",
	namespace: Array(4).fill("a".repeat(64)).join("/"),
	bucket: "private",
	key: "owner1234/video1234/private/edited/revision1234/7/attempt.mp4",
	versionId: "version1",
	sha256: "a".repeat(64),
	size: 123,
};
receipt.hls = {
	validation: "verified",
	snapshot: { captionsVtt: "", chapters: [], thumbnailSha256: "" },
	artifacts: Object.fromEntries(
		[
			"playlist.m3u8",
			"init.mp4",
			"seg/0.m4s",
			"captions.vtt",
			"chapters.json",
			"thumbnail.jpg",
		].map((name) => [name, { ...receipt }]),
	),
};

function workerDb() {
	const state = {
		currentRevisionId: identity.revisionId,
		currentGeneration: 7,
		tokenChanged: false,
		expired: false,
		expireOnLock: false,
		snapshotChanged: false,
		ready: false,
		receipt: undefined as unknown,
		localReady: transfer.localReady,
		deleted: false,
		polls: 0,
		attempts: 0,
	};
	let payload: Record<string, unknown> = {
		job: "download",
		videoId: identity.videoId,
		revisionId: identity.revisionId,
	};
	let taken = false;
	const app = {
		select() {
			let table = "";
			const run = () => {
				if (table === "revision_artifact_status") return [];
				if (table === "video_publication")
					return [
						{
							currentRevisionId: state.currentRevisionId,
							currentGeneration: state.currentGeneration,
						},
					];
				if (table === "edit_revision")
					return [
						{
							...identity,
							metadataSnapshot: { downloadArtifact: state.receipt },
						},
					];
				if (table === "outbox") return [{ id: 1, payload: { ...payload } }];
				return [];
			};
			const chain = Object.assign(Promise.resolve().then(run), {
				from(value: Table) {
					table = getTableName(value);
					return chain;
				},
				where() {
					return chain;
				},
				innerJoin() {
					return chain;
				},
				orderBy() {
					return chain;
				},
				limit() {
					return chain;
				},
				for() {
					if (taken) return Promise.resolve([]);
					taken = true;
					return Promise.resolve(run());
				},
			});
			return chain;
		},
		update(table: Table) {
			return {
				set(value: Record<string, unknown>) {
					return {
						where: async () => {
							if (getTableName(table) === "outbox" && value.payload)
								payload = value.payload as Record<string, unknown>;
							if (value.state === "READY") state.ready = true;
						},
					};
				},
			};
		},
		delete() {
			return {
				where: async () => {
					state.deleted = true;
				},
			};
		},
		transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> =>
			run(app),
		execute: async (query: Parameters<MySqlDialect["sqlToQuery"]>[0]) => {
			const compiled = dialect.sqlToQuery(query);
			if (compiled.sql.includes("FOR UPDATE")) {
				await Promise.resolve();
				if (state.expireOnLock) state.expired = true;
				return [[{ revisionId: identity.revisionId }], []];
			}
			expect(compiled.sql).toContain("p.currentGeneration = r.generation");
			expect(compiled.sql).toContain(
				"p.currentRevisionId = BINARY r.revisionId",
			);
			expect(compiled.sql).toContain("'$.leaseToken'");
			expect(compiled.sql).toContain("'$.leaseUntilMs'");
			expect(compiled.sql).toContain("UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))");
			expect(compiled.params).toContain(payload.leaseToken);
			const stored = compiled.params.find(
				(value) => typeof value === "string" && value.startsWith('{"ownerId"'),
			);
			if (typeof stored !== "string") throw new Error("Missing receipt");
			const completed = JSON.parse(stored) as DownloadReceipt;
			if (completed.hls) {
				expect(compiled.sql).toContain("'$.captionsVtt'");
				expect(compiled.sql).toContain("'$.chapters'");
				expect(compiled.sql).toContain("'$.thumbnailSha256'");
			}
			const allowed =
				(!completed.hls || !state.snapshotChanged) &&
				!state.tokenChanged &&
				!state.expired &&
				state.currentRevisionId === identity.revisionId &&
				state.currentGeneration === identity.generation;
			if (allowed) {
				state.ready = true;
				state.receipt = completed;
			}
			return [{ affectedRows: allowed ? 2 : 0 }, []];
		},
	};
	return { app, state };
}

describe("post-await durable job completion fencing", () => {
	beforeEach(() => {
		Object.assign(transfer, {
			calls: 0,
			failed: false,
			hlsFailed: false,
			hlsCalls: 0,
			localReady: false,
			wait: null,
			hlsWait: null,
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	it("does not hold the publication tick while a single background export is in flight", async () => {
		let release = () => {};
		transfer.wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { app, state } = workerDb();
		const input = {
			limit: 1,
			origin: {
				prepareRevision: vi.fn(),
				selectFrames: vi.fn(),
				fetchArtifact: vi.fn(),
				requestDownload: async () => ({ status: 200 }),
			},
		};
		try {
			await startSweep(app, input);
			await vi.waitFor(() => expect(transfer.calls).toBe(1));
			expect(state.ready).toBe(false);
			await startSweep(app, input);
			expect(transfer.calls).toBe(1);
		} finally {
			release();
			await pendingRevisionDownloads();
		}
		expect(state.ready).toBe(true);
	});
	it.each([
		"revision",
		"generation",
		"lease-replaced",
		"lease-expired",
		"side-snapshot",
	])("cannot publish after %s changes during upload/readback", async (race) => {
		let release = () => {};
		transfer.wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { app, state } = workerDb();
		const run = sweepRevisionDownloads(app, {
			limit: 1,
			origin: {
				prepareRevision: vi.fn(),
				selectFrames: vi.fn(),
				fetchArtifact: vi.fn(),
				requestDownload: async () => ({ status: 200 }),
			},
		});
		try {
			await vi.waitFor(() => expect(transfer.calls).toBe(1));
			if (race === "revision") state.currentRevisionId = "newrevision";
			if (race === "generation") state.currentGeneration += 1;
			if (race === "lease-replaced") state.tokenChanged = true;
			if (race === "lease-expired") state.expired = true;
			if (race === "side-snapshot") state.snapshotChanged = true;
		} finally {
			release();
			await run;
		}
		expect(state.ready).toBe(race === "side-snapshot");
		if (race === "side-snapshot") {
			expect((state.receipt as DownloadReceipt).hls).toBeUndefined();
		} else expect(state.receipt).toBeUndefined();
		expect(state.deleted).toBe(false);
	});
	it.each([
		"revision",
		"generation",
		"lease-replaced",
		"lease-expired",
		"lock-wait-expired",
	])(
		"cannot mark READY after %s changed during the origin await",
		async (race) => {
			const { app, state } = workerDb();
			await sweepRevisionDownloads(app, {
				limit: 1,
				origin: {
					prepareRevision: vi.fn(),
					selectFrames: vi.fn(),
					fetchArtifact: vi.fn(),
					requestDownload: async () => {
						await Promise.resolve();
						if (race === "revision") state.currentRevisionId = "newrevision";
						if (race === "generation") state.currentGeneration += 1;
						if (race === "lease-replaced") state.tokenChanged = true;
						if (race === "lease-expired") state.expired = true;
						if (race === "lock-wait-expired") state.expireOnLock = true;
						return { status: 200 };
					},
				},
			});
			expect(state.ready).toBe(false);
			expect(transfer.calls).toBe(1);
			expect(state.receipt).toBeUndefined();
			expect(state.deleted).toBe(false);
		},
	);
	it("records the verified receipt and consumes the held job when still current", async () => {
		const { app, state } = workerDb();
		await sweepRevisionDownloads(app, {
			limit: 1,
			origin: {
				prepareRevision: vi.fn(),
				selectFrames: vi.fn(),
				fetchArtifact: vi.fn(),
				requestDownload: async () => ({ status: 200 }),
			},
		});
		expect(state.ready).toBe(true);
		expect(state.receipt).toEqual(receipt);
		expect(state.deleted).toBe(true);
	});
	it("old local-only READY still performs the durability transfer", async () => {
		transfer.localReady = true;
		const { app, state } = workerDb();
		await sweepRevisionDownloads(app, {
			limit: 1,
			origin: {
				prepareRevision: vi.fn(),
				selectFrames: vi.fn(),
				fetchArtifact: vi.fn(),
				requestDownload: async () => ({ status: 200 }),
			},
		});
		expect(transfer.calls).toBe(1);
		expect(state.receipt).toEqual(receipt);
		expect(state.localReady).toBe(true);
	});
	it.each([
		"revision",
		"generation",
		"lease-replaced",
		"lease-expired",
		"side-snapshot",
	])(
		"retains MP4 but cannot attach HLS after %s changes during side readback",
		async (race) => {
			let release = () => {};
			transfer.hlsWait = new Promise<void>((resolve) => {
				release = resolve;
			});
			const { app, state } = workerDb();
			const run = sweepRevisionDownloads(app, {
				limit: 1,
				origin: {
					prepareRevision: vi.fn(),
					selectFrames: vi.fn(),
					fetchArtifact: vi.fn(),
					requestDownload: async () => ({ status: 200 }),
				},
			});
			try {
				await vi.waitFor(() => expect(transfer.hlsCalls).toBe(1));
				expect(state.ready).toBe(true);
				expect((state.receipt as DownloadReceipt).hls).toBeUndefined();
				if (race === "revision") state.currentRevisionId = "newrevision";
				if (race === "generation") state.currentGeneration += 1;
				if (race === "lease-replaced") state.tokenChanged = true;
				if (race === "lease-expired") state.expired = true;
				if (race === "side-snapshot") state.snapshotChanged = true;
			} finally {
				release();
				await run;
			}
			expect((state.receipt as DownloadReceipt).hls).toBeUndefined();
			expect(state.deleted).toBe(false);
			expect(transfer.calls).toBe(1);
		},
	);
	it("publishes verified MP4 independently of permanent thumbnail failure", async () => {
		transfer.hlsFailed = true;
		const { app, state } = workerDb();
		await sweepRevisionDownloads(app, {
			limit: 1,
			origin: {
				prepareRevision: vi.fn(),
				selectFrames: vi.fn(),
				fetchArtifact: vi.fn(),
				requestDownload: async () => ({ status: 200 }),
			},
		});
		expect(state.ready).toBe(true);
		expect(state.receipt).toEqual({ ...receipt, hls: undefined });
		expect(state.deleted).toBe(false);
		expect(transfer.calls).toBe(1);
	});
	it("reuses a verified READY MP4 when HLS backfill fails", async () => {
		transfer.localReady = true;
		transfer.hlsFailed = true;
		const { app, state } = workerDb();
		state.receipt = { ...receipt, hls: undefined };
		const requestDownload = vi.fn(async () => ({ status: 202 }));
		await sweepRevisionDownloads(app, {
			limit: 1,
			origin: {
				prepareRevision: vi.fn(),
				selectFrames: vi.fn(),
				fetchArtifact: vi.fn(),
				requestDownload,
			},
		});
		expect(transfer.hlsCalls).toBe(1);
		expect(transfer.calls).toBe(0);
		expect(requestDownload).not.toHaveBeenCalled();
		expect(state.receipt).toEqual({ ...receipt, hls: undefined });
	});
	it("readback failure is contained by the background sweep and cannot change publication", async () => {
		transfer.failed = true;
		const { app, state } = workerDb();
		await expect(
			sweepRevisionDownloads(app, {
				limit: 1,
				origin: {
					prepareRevision: vi.fn(),
					selectFrames: vi.fn(),
					fetchArtifact: vi.fn(),
					requestDownload: async () => ({ status: 200 }),
				},
			}),
		).resolves.toBeUndefined();
		expect(state.ready).toBe(false);
		expect(state.currentRevisionId).toBe(identity.revisionId);
		expect(state.receipt).toBeUndefined();
	});
});

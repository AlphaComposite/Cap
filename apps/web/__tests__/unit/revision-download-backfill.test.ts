import { getTableName, type Table } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://127.0.0.1:3000" },
	serverEnv: () => ({ NEXTAUTH_SECRET: "test-secret-with-enough-entropy" }),
}));
vi.mock("@/lib/server", () => ({
	runPromise: async (effect: unknown) => effect,
}));
vi.mock("@cap/database", () => ({
	db: () => ({ execute: async () => [] }),
}));
vi.mock("@cap/web-backend", () => ({
	VideosPolicy: class VideosPolicy {},
	provideOptionalAuth: <T>(effect: T) => effect,
}));

import { revisionArtifactStatus, revisionOutbox } from "@cap/database/schema";
import { drainRevisionDownloads as sweepRevisionDownloads } from "@/lib/revision-download-job";

const dialect = new MySqlDialect();

type Pending = {
	revisionId: string;
	videoId: string;
	queued: boolean;
	state?: "READY";
	attempts?: number;
	durabilityStarted?: boolean;
	verified?: boolean;
	hlsVerified?: boolean;
	hlsStarted?: boolean;
};

function whereSql(where: unknown): string {
	try {
		return dialect.sqlToQuery(where as never).sql.toLowerCase();
	} catch {
		return "";
	}
}

function whereParams(where: unknown): unknown[] {
	try {
		return [...dialect.sqlToQuery(where as never).params];
	} catch {
		return [];
	}
}

function backfillDb(pending: Pending[], inserted: string[]) {
	const queued = new Set(
		pending.filter((row) => row.queued).map((row) => row.revisionId),
	);
	const database = {
		select() {
			const state: {
				table?: Table;
				where?: unknown;
				limit?: number;
			} = {};
			const api = {
				from(table: Table) {
					state.table = table;
					return api;
				},
				innerJoin() {
					return api;
				},
				where(condition: unknown) {
					state.where = condition;
					return api;
				},
				limit(count: number) {
					state.limit = count;
					return Promise.resolve(execute(state));
				},
			};
			return api;
		},
		insert() {
			return {
				values: async (row: { revisionId: string }) => {
					inserted.push(row.revisionId);
					queued.add(row.revisionId);
				},
			};
		},
		transaction: async () => null,
		execute: async (query: unknown) => {
			const text = whereSql(query);
			if (text.includes("hlsdurabilitystarted")) {
				for (const row of pending) {
					if (!row.hlsStarted) {
						row.durabilityStarted = true;
						row.hlsStarted = true;
						row.attempts = 0;
					}
				}
			}
			return [];
		},
	};

	function execute(state: { table?: Table; where?: unknown; limit?: number }) {
		const name = state.table ? getTableName(state.table) : "";
		if (name === getTableName(revisionArtifactStatus)) {
			const sql = whereSql(state.where);
			const excludesQueued =
				sql.includes("not exists") ||
				(sql.includes("is null") && sql.includes("outbox"));
			let rows = pending.filter((row) => !excludesQueued || !row.queued);
			rows = rows.filter(
				(row) =>
					row.state !== "READY" ||
					(sql.includes("hlsdurabilitystarted") &&
						!row.hlsVerified &&
						(!row.hlsStarted || (row.attempts ?? 0) < 3)),
			);
			if (state.limit != null) rows = rows.slice(0, state.limit);
			return rows.map((row) => ({
				revisionId: row.revisionId,
				videoId: row.videoId,
				state: row.state,
				attempts: row.attempts ?? 0,
			}));
		}
		if (name === getTableName(revisionOutbox)) {
			const revisionId = whereParams(state.where).find(
				(value) => typeof value === "string" && value !== "download",
			);
			if (typeof revisionId === "string" && queued.has(revisionId)) {
				return [{ id: 1 }];
			}
			return [];
		}
		return [];
	}

	return database;
}

describe("revision download backfill", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it.each([
		{
			durabilityStarted: false,
			verified: false,
			hlsStarted: false,
			hlsVerified: false,
			enqueued: true,
		},
		{
			durabilityStarted: true,
			verified: true,
			hlsStarted: false,
			hlsVerified: false,
			enqueued: true,
		},
		{
			durabilityStarted: true,
			verified: false,
			hlsStarted: true,
			hlsVerified: false,
			enqueued: false,
		},
		{
			durabilityStarted: true,
			verified: true,
			hlsStarted: true,
			hlsVerified: true,
			enqueued: false,
		},
	])(
		"backfills old READY independently of legacy retry counts and preserves the durability cap: %j",
		async ({
			durabilityStarted,
			verified,
			hlsStarted,
			hlsVerified,
			enqueued,
		}) => {
			const row: Pending = {
				revisionId: "old-ready",
				videoId: "vid-old",
				queued: false,
				state: "READY",
				attempts: 3,
				durabilityStarted,
				verified,
				hlsStarted,
				hlsVerified,
			};
			const inserted: string[] = [];
			await sweepRevisionDownloads(backfillDb([row], inserted), {
				origin: {
					prepareRevision: vi.fn(),
					selectFrames: vi.fn(),
					fetchArtifact: vi.fn(),
				},
				limit: 1,
			});
			expect(inserted).toEqual(enqueued ? [row.revisionId] : []);
			expect(row.attempts).toBe(enqueued ? 0 : 3);
			expect(row.state).toBe("READY");
		},
	);
	it("enqueues an unqueued pending revision when four are already queued", async () => {
		const pending: Pending[] = [
			...Array.from({ length: 4 }, (_, index) => ({
				revisionId: `queued-${index}`,
				videoId: `vid-${index}`,
				queued: true,
			})),
			{ revisionId: "unqueued", videoId: "vid-new", queued: false },
		];
		const inserted: string[] = [];
		await sweepRevisionDownloads(backfillDb(pending, inserted), {
			origin: {
				prepareRevision: async () => {
					throw new Error("Unexpected prepare");
				},
				selectFrames: async () => {
					throw new Error("Unexpected frame selection");
				},
				fetchArtifact: async () => {
					throw new Error("Unexpected artifact fetch");
				},
				requestDownload: async () => ({ status: 202, body: "" }),
			},
			now: new Date(1_000),
			limit: 4,
		});
		expect(inserted).toEqual(["unqueued"]);
	});
});

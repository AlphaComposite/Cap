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
import { sweepRevisionDownloads } from "@/lib/revision-download-job";

const dialect = new MySqlDialect();

type Pending = { revisionId: string; videoId: string; queued: boolean };

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
	};

	function execute(state: { table?: Table; where?: unknown; limit?: number }) {
		const name = state.table ? getTableName(state.table) : "";
		if (name === getTableName(revisionArtifactStatus)) {
			const sql = whereSql(state.where);
			const excludesQueued =
				sql.includes("not exists") ||
				(sql.includes("is null") && sql.includes("outbox"));
			let rows = pending.filter((row) => !excludesQueued || !row.queued);
			if (state.limit != null) rows = rows.slice(0, state.limit);
			return rows.map((row) => ({
				revisionId: row.revisionId,
				videoId: row.videoId,
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

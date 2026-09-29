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

import {
	revisionArtifactStatus,
	revisionOutbox,
	videoPublication,
} from "@cap/database/schema";
import {
	DOWNLOAD_MAX_FAILURES,
	DOWNLOAD_MAX_POLLS,
	sweepRevisionDownloads,
} from "@/lib/revision-download-job";

const dialect = new MySqlDialect();
const COOLDOWN_MS = 30 * 60 * 1000;
const MAX_FAILED_CYCLES = 3;

type Artifact = {
	revisionId: string;
	videoId: string;
	state: "PENDING" | "FAILED" | "READY";
	attempts: number;
	heartbeatAt: Date | null;
	current: boolean;
};

type Job = {
	id: number;
	revisionId: string;
	videoId: string;
	payload: Record<string, unknown>;
	createdAt: Date;
};

function queryText(value: unknown): { sql: string; params: unknown[] } {
	try {
		const query = dialect.sqlToQuery(value as never);
		return { sql: query.sql.toLowerCase(), params: [...query.params] };
	} catch {
		return { sql: "", params: [] };
	}
}

function asTime(value: unknown): number | null {
	if (value instanceof Date) return value.getTime();
	if (typeof value !== "string") return null;
	const mysql =
		/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(
			value,
		);
	if (mysql) {
		const fraction = mysql[7] ?? "0";
		return Date.UTC(
			Number(mysql[1]),
			Number(mysql[2]) - 1,
			Number(mysql[3]),
			Number(mysql[4]),
			Number(mysql[5]),
			Number(mysql[6]),
			Number(fraction.padEnd(3, "0")),
		);
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function workerDb(artifacts: Artifact[], jobs: Job[], inserted: string[]) {
	let nextId = jobs.reduce((max, job) => Math.max(max, job.id), 0) + 1;
	const database = {
		select() {
			return chain((state) => executeSelect(state));
		},
		insert(table: Table) {
			return {
				values: async (row: {
					revisionId: string;
					videoId: string;
					payload: Record<string, unknown>;
					createdAt: Date;
				}) => {
					if (getTableName(table) !== getTableName(revisionOutbox)) return;
					jobs.push({
						id: nextId,
						revisionId: row.revisionId,
						videoId: row.videoId,
						payload: { ...row.payload },
						createdAt: row.createdAt,
					});
					nextId += 1;
					inserted.push(row.revisionId);
				},
			};
		},
		update(table: Table) {
			return chain((state) => {
				applyUpdate(table, state);
			});
		},
		delete(table: Table) {
			return chain((state) => {
				applyDelete(table, state);
			});
		},
		execute: async (query: unknown) => {
			const { params } = queryText(query);
			const revisionId = params.find(
				(value) => typeof value === "string" && value !== "download",
			);
			const row = artifacts.find((item) => item.revisionId === revisionId);
			return [{ state: row?.state ?? "PENDING" }];
		},
		transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(database),
	};

	function chain(run: (state: QueryState) => unknown) {
		const state: QueryState = {};
		let pending: Promise<unknown> | null = null;
		const start = () => {
			pending ??= Promise.resolve().then(() => run(state));
			return pending;
		};
		const methods = {
			from(table: Table) {
				state.table = table;
				return proxy;
			},
			innerJoin() {
				return proxy;
			},
			where(condition: unknown) {
				state.where = condition;
				return proxy;
			},
			orderBy() {
				return proxy;
			},
			limit(count: number) {
				state.limit = count;
				return proxy;
			},
			for() {
				return proxy;
			},
			set(values: Record<string, unknown>) {
				state.set = values;
				return proxy;
			},
		};
		const proxy = new Proxy(methods, {
			get(target, prop, receiver) {
				if (prop === "then" || prop === "catch" || prop === "finally") {
					const promise = start();
					const value = Reflect.get(promise, prop, promise);
					return typeof value === "function" ? value.bind(promise) : value;
				}
				return Reflect.get(target, prop, receiver);
			},
		});
		return proxy;
	}

	function executeSelect(state: QueryState) {
		const name = state.table ? getTableName(state.table) : "";
		const { sql, params } = queryText(state.where);
		if (name === getTableName(videoPublication)) {
			const videoId = params.find((value) => typeof value === "string");
			const row = artifacts.find(
				(item) => item.videoId === videoId && item.current,
			);
			return row ? [{ currentRevisionId: row.revisionId }] : [];
		}
		if (name === getTableName(revisionOutbox)) {
			if (sql.includes("leaseuntilms")) {
				const nowMs = Math.max(
					0,
					...params.filter(
						(value): value is number => typeof value === "number",
					),
				);
				let due = jobs.filter((job) => {
					const lease = job.payload.leaseUntilMs;
					const notBefore = job.payload.notBeforeMs;
					const leaseOk = typeof lease !== "number" || lease <= nowMs;
					const ready = typeof notBefore !== "number" || notBefore <= nowMs;
					return leaseOk && ready;
				});
				due = [...due].sort((left, right) => left.id - right.id);
				if (state.limit != null) due = due.slice(0, state.limit);
				return due.map((job) => ({
					id: job.id,
					revisionId: job.revisionId,
					videoId: job.videoId,
					job: "download",
					payload: job.payload,
					createdAt: job.createdAt,
				}));
			}
			const id = params.find((value) => typeof value === "number");
			const revisionId = params.find(
				(value) => typeof value === "string" && value !== "download",
			);
			if (typeof revisionId === "string") {
				const job = jobs.find((item) => item.revisionId === revisionId);
				return job ? [{ id: job.id }] : [];
			}
			if (typeof id === "number") {
				const job = jobs.find((item) => item.id === id);
				return job ? [{ id: job.id, payload: job.payload }] : [];
			}
			return [];
		}
		if (name === getTableName(revisionArtifactStatus)) {
			const wantsPending = params.includes("PENDING");
			const wantsFailed = params.includes("FAILED");
			const numbers = params.filter(
				(value): value is number => typeof value === "number",
			);
			const cooledAt = params
				.map(asTime)
				.find((value): value is number => value != null);
			let rows = artifacts.filter((row) => {
				if (!row.current) return false;
				if (
					sql.includes("not exists") &&
					jobs.some((job) => job.revisionId === row.revisionId)
				) {
					return false;
				}
				if (wantsPending && row.state === "PENDING") return true;
				if (!wantsFailed || row.state !== "FAILED") return false;
				const cyclesOk =
					row.attempts < MAX_FAILED_CYCLES ||
					(numbers.includes(DOWNLOAD_MAX_FAILURES) &&
						row.attempts > DOWNLOAD_MAX_FAILURES);
				const cooled =
					cooledAt == null ||
					row.heartbeatAt == null ||
					row.heartbeatAt.getTime() <= cooledAt;
				return cyclesOk && cooled;
			});
			if (state.limit != null) rows = rows.slice(0, state.limit);
			return rows.map((row) => ({
				revisionId: row.revisionId,
				videoId: row.videoId,
				state: row.state,
				attempts: row.attempts,
			}));
		}
		return [];
	}

	function applyUpdate(table: Table, state: QueryState) {
		const name = getTableName(table);
		const { params } = queryText(state.where);
		const set = state.set ?? {};
		if (name === getTableName(revisionOutbox)) {
			const id = params.find((value) => typeof value === "number");
			const job = jobs.find((item) => item.id === id);
			if (!job || !set.payload || typeof set.payload !== "object") return;
			job.payload = { ...(set.payload as Record<string, unknown>) };
			return;
		}
		if (name !== getTableName(revisionArtifactStatus)) return;
		const revisionId = params.find(
			(value) => typeof value === "string" && value !== "download",
		);
		const row = artifacts.find((item) => item.revisionId === revisionId);
		if (!row) return;
		if (params.includes("FAILED") && row.state !== "FAILED") return;
		if (
			set.state === "PENDING" ||
			set.state === "FAILED" ||
			set.state === "READY"
		) {
			row.state = set.state;
		}
		if (typeof set.attempts === "number") row.attempts = set.attempts;
		if (set.heartbeatAt instanceof Date) row.heartbeatAt = set.heartbeatAt;
	}

	function applyDelete(table: Table, state: QueryState) {
		if (getTableName(table) !== getTableName(revisionOutbox)) return;
		const { params } = queryText(state.where);
		const id = params.find((value) => typeof value === "number");
		const index = jobs.findIndex((job) => job.id === id);
		if (index < 0) return;
		const token = params.find(
			(value) => typeof value === "string" && value.length > 8,
		);
		if (
			typeof token === "string" &&
			jobs[index]?.payload.leaseToken !== token
		) {
			return;
		}
		jobs.splice(index, 1);
	}

	return database;
}

type QueryState = {
	table?: Table;
	where?: unknown;
	limit?: number;
	set?: Record<string, unknown>;
};

describe("revision download exhaustion", () => {
	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("leaves a long 202 build PENDING and lets the next sweep re-enqueue it", async () => {
		const artifact: Artifact = {
			revisionId: "rev-long",
			videoId: "vid-long",
			state: "PENDING",
			attempts: 0,
			heartbeatAt: null,
			current: true,
		};
		const jobs: Job[] = [
			{
				id: 7,
				revisionId: artifact.revisionId,
				videoId: artifact.videoId,
				createdAt: new Date(0),
				payload: {
					job: "download",
					revisionId: artifact.revisionId,
					videoId: artifact.videoId,
					polls: DOWNLOAD_MAX_POLLS,
					attempts: 0,
				},
			},
		];
		const inserted: string[] = [];
		let calls = 0;
		const database = workerDb([artifact], jobs, inserted);
		const origin = {
			prepareRevision: async () => {
				throw new Error("Unexpected prepare");
			},
			fetchArtifact: async () => {
				throw new Error("Unexpected artifact fetch");
			},
			requestDownload: async () => {
				calls += 1;
				return { status: 202, body: "" };
			},
		};

		await sweepRevisionDownloads(database, {
			origin,
			now: new Date(1_000_000),
			limit: 1,
		});

		expect(calls).toBe(1);
		expect(artifact.state).toBe("PENDING");
		expect(artifact.attempts).toBe(0);
		expect(jobs).toHaveLength(0);
		expect(console.error).not.toHaveBeenCalledWith(
			"cap-revision-download-failed",
			artifact.videoId,
			artifact.revisionId,
			"DownloadAttemptsExhausted",
		);

		await sweepRevisionDownloads(database, {
			origin,
			now: new Date(1_000_000),
			limit: 1,
		});
		expect(inserted).toEqual([artifact.revisionId]);
		expect(artifact.state).toBe("PENDING");
	});

	it("still marks the artifact FAILED when real origin errors are exhausted", async () => {
		const artifact: Artifact = {
			revisionId: "rev-err",
			videoId: "vid-err",
			state: "PENDING",
			attempts: 0,
			heartbeatAt: null,
			current: true,
		};
		const jobs: Job[] = [
			{
				id: 3,
				revisionId: artifact.revisionId,
				videoId: artifact.videoId,
				createdAt: new Date(0),
				payload: {
					job: "download",
					revisionId: artifact.revisionId,
					videoId: artifact.videoId,
					polls: 1,
					attempts: DOWNLOAD_MAX_FAILURES,
				},
			},
		];
		const database = workerDb([artifact], jobs, []);
		await sweepRevisionDownloads(database, {
			origin: {
				prepareRevision: async () => {
					throw new Error("Unexpected prepare");
				},
				fetchArtifact: async () => {
					throw new Error("Unexpected artifact fetch");
				},
				requestDownload: async () => ({ status: 500, body: "" }),
			},
			now: new Date(5_000),
			limit: 1,
		});
		expect(artifact.state).toBe("FAILED");
		expect(artifact.attempts).toBeLessThan(MAX_FAILED_CYCLES);
		expect(artifact.heartbeatAt).toEqual(new Date(5_000));
		expect(jobs).toHaveLength(0);
		expect(console.error).toHaveBeenCalledWith(
			"cap-revision-download-failed",
			artifact.videoId,
			artifact.revisionId,
			"DownloadAttemptsExhausted",
		);
	});

	it("re-enqueues a cooled FAILED current download at most three cycles", async () => {
		const now = new Date(10_000_000);
		const cooled = new Date(now.getTime() - COOLDOWN_MS - 1);
		const recent = new Date(now.getTime() - 60_000);
		const artifacts: Artifact[] = [
			{
				revisionId: "rev-cool",
				videoId: "vid-cool",
				state: "FAILED",
				attempts: 1,
				heartbeatAt: cooled,
				current: true,
			},
			{
				revisionId: "rev-hot",
				videoId: "vid-hot",
				state: "FAILED",
				attempts: 1,
				heartbeatAt: recent,
				current: true,
			},
			{
				revisionId: "rev-capped",
				videoId: "vid-capped",
				state: "FAILED",
				attempts: MAX_FAILED_CYCLES,
				heartbeatAt: cooled,
				current: true,
			},
			{
				revisionId: "rev-legacy",
				videoId: "vid-legacy",
				state: "FAILED",
				attempts: DOWNLOAD_MAX_FAILURES + 1,
				heartbeatAt: cooled,
				current: true,
			},
			{
				revisionId: "rev-old",
				videoId: "vid-old",
				state: "FAILED",
				attempts: 1,
				heartbeatAt: cooled,
				current: false,
			},
		];
		const inserted: string[] = [];
		await sweepRevisionDownloads(workerDb(artifacts, [], inserted), {
			origin: {
				prepareRevision: async () => {
					throw new Error("Unexpected prepare");
				},
				fetchArtifact: async () => {
					throw new Error("Unexpected artifact fetch");
				},
				requestDownload: async () => ({ status: 202, body: "" }),
			},
			now,
			limit: 4,
		});
		expect(inserted.slice().sort()).toEqual(["rev-cool", "rev-legacy"]);
		expect(artifacts.find((row) => row.revisionId === "rev-cool")?.state).toBe(
			"PENDING",
		);
		expect(artifacts.find((row) => row.revisionId === "rev-hot")?.state).toBe(
			"FAILED",
		);
		expect(
			artifacts.find((row) => row.revisionId === "rev-capped")?.state,
		).toBe("FAILED");
	});
});

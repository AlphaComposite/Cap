import { Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.fn();
const mockStart = vi.fn();

vi.mock("@cap/database", () => ({ db: mockDb }));

vi.mock("@cap/database/schema", () => ({
	importedVideos: {},
	videos: {},
	videoUploads: {
		videoId: "videoId",
		phase: "phase",
		processingProgress: "processingProgress",
		processingMessage: "processingMessage",
		processingError: "processingError",
		rawFileKey: "rawFileKey",
		startedAt: "startedAt",
		updatedAt: "updatedAt",
		recoveryAttemptCount: "recoveryAttemptCount",
		recoveryClaimId: "recoveryClaimId",
		recoveryLeaseExpiresAt: "recoveryLeaseExpiresAt",
	},
}));

type Expression = {
	op: string;
	args: unknown[];
};

const expression = (op: string, ...args: unknown[]): Expression => ({
	op,
	args,
});

function isExpression(value: unknown): value is Expression {
	return (
		typeof value === "object" &&
		value !== null &&
		"op" in value &&
		typeof value.op === "string" &&
		"args" in value &&
		Array.isArray(value.args)
	);
}

vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => expression("and", ...args),
	asc: (value: unknown) => value,
	eq: (...args: unknown[]) => expression("eq", ...args),
	gte: (...args: unknown[]) => expression("gte", ...args),
	isNotNull: (...args: unknown[]) => expression("isNotNull", ...args),
	isNull: (...args: unknown[]) => expression("isNull", ...args),
	like: (...args: unknown[]) => expression("like", ...args),
	lt: (...args: unknown[]) => expression("lt", ...args),
	lte: (...args: unknown[]) => expression("lte", ...args),
	notLike: (...args: unknown[]) => expression("notLike", ...args),
	or: (...args: unknown[]) => expression("or", ...args),
	sql: (_strings: TemplateStringsArray, column: unknown) =>
		expression("increment", column),
}));

vi.mock("workflow/api", () => ({ start: mockStart }));
vi.mock("@/lib/video-processing", () => ({ setVideoProcessingError: vi.fn() }));
vi.mock("@/workflows/process-video", () => ({ processVideoWorkflow: vi.fn() }));
vi.mock("@/workflows/import-loom-video", () => ({
	importLoomVideoWorkflow: vi.fn(),
}));

type RecoveryRow = {
	videoId: string;
	phase: string;
	rawFileKey: string;
	processingError: string;
	startedAt: Date;
	updatedAt: Date;
	recoveryAttemptCount: number;
	recoveryClaimId: string | null;
	recoveryLeaseExpiresAt: Date | null;
	processingProgress?: number;
	processingMessage?: string | null;
};

function value(row: RecoveryRow, operand: unknown) {
	return typeof operand === "string" && operand in row
		? row[operand as keyof RecoveryRow]
		: operand;
}

function evaluate(row: RecoveryRow, condition: unknown): boolean {
	if (!isExpression(condition)) return true;
	const { op, args } = condition;
	if (op === "and") return args.every((item) => evaluate(row, item));
	if (op === "or") return args.some((item) => evaluate(row, item));
	const left = value(row, args[0]);
	const right = value(row, args[1]);
	if (op === "eq") return left === right;
	if (op === "lt")
		return left instanceof Date && right instanceof Date
			? left < right
			: Number(left) < Number(right);
	if (op === "lte")
		return left instanceof Date && right instanceof Date
			? left <= right
			: Number(left) <= Number(right);
	if (op === "gte")
		return left instanceof Date && right instanceof Date
			? left >= right
			: Number(left) >= Number(right);
	if (op === "isNull") return left === null;
	if (op === "isNotNull") return left !== null;
	if (op === "like" || op === "notLike") {
		const needle = String(right).replaceAll("%", "");
		const matches = String(left).includes(needle);
		return op === "like" ? matches : !matches;
	}
	throw new Error(`Unsupported expression ${op}`);
}

function statefulUpdate(row: RecoveryRow) {
	let changes: Partial<RecoveryRow> = {};
	const chain = {
		update: vi.fn(),
		set: vi.fn((next: Partial<RecoveryRow>) => {
			changes = next;
			return chain;
		}),
		where: vi.fn(async (condition: unknown) => {
			if (!evaluate(row, condition)) return [{ affectedRows: 0 }];
			for (const [key, next] of Object.entries(changes)) {
				if (isExpression(next) && next.op === "increment") {
					const [column] = next.args;
					row[key as keyof RecoveryRow] = (Number(value(row, column)) +
						1) as never;
				} else {
					row[key as keyof RecoveryRow] = next as never;
				}
			}
			return [{ affectedRows: 1 }];
		}),
	};
	chain.update.mockReturnValue(chain);
	return chain;
}

const now = new Date("2026-09-22T12:00:00.000Z");
const staleBefore = new Date("2026-09-22T11:50:00.000Z");
const recentAfter = new Date("2026-09-20T12:00:00.000Z");
const videoId = Video.VideoId.make("video-1");

function recoveryRow(overrides: Partial<RecoveryRow> = {}): RecoveryRow {
	return {
		videoId,
		phase: "error",
		rawFileKey: "user-1/video-1/raw.mp4",
		processingError: "Server shutting down",
		startedAt: new Date("2026-09-22T10:00:00.000Z"),
		updatedAt: new Date("2026-09-22T11:45:00.000Z"),
		recoveryAttemptCount: 3,
		recoveryClaimId: null,
		recoveryLeaseExpiresAt: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockStart.mockResolvedValue({ runId: "run-1" });
});

describe("web video recovery claims", () => {
	it("never dispatches when the durable recovery attempt budget is exhausted", async () => {
		const row = recoveryRow();
		mockDb.mockReturnValue(statefulUpdate(row));
		const { recoverWebCandidate } = await import(
			"@/lib/video-processing-recovery"
		);

		const status = await recoverWebCandidate({
			videoId,
			userId: "user-1",
			rawFileKey: row.rawFileKey,
			bucketId: null,
			staleBefore,
			recentAfter,
			now,
		});

		expect(status).toBe("already-claimed");
		expect(mockStart).not.toHaveBeenCalled();
		expect(row.recoveryAttemptCount).toBe(3);
	});

	it("never dispatches while another recovery claim lease is unexpired", async () => {
		const row = recoveryRow({
			recoveryAttemptCount: 1,
			recoveryClaimId: "active-claim",
			recoveryLeaseExpiresAt: new Date("2026-09-22T12:00:00.001Z"),
		});
		mockDb.mockReturnValue(statefulUpdate(row));
		const { recoverWebCandidate } = await import(
			"@/lib/video-processing-recovery"
		);

		const status = await recoverWebCandidate({
			videoId,
			userId: "user-1",
			rawFileKey: row.rawFileKey,
			bucketId: null,
			staleBefore,
			recentAfter,
			now,
		});

		expect(status).toBe("already-claimed");
		expect(mockStart).not.toHaveBeenCalled();
		expect(row.recoveryAttemptCount).toBe(1);
		expect(row.recoveryClaimId).toBe("active-claim");
	});

	it("reclaims an expired lease and atomically consumes the next attempt", async () => {
		const row = recoveryRow({
			recoveryAttemptCount: 1,
			recoveryClaimId: "expired-claim",
			recoveryLeaseExpiresAt: now,
		});
		mockDb.mockReturnValue(statefulUpdate(row));
		const { recoverWebCandidate } = await import(
			"@/lib/video-processing-recovery"
		);

		const status = await recoverWebCandidate({
			videoId,
			userId: "user-1",
			rawFileKey: row.rawFileKey,
			bucketId: null,
			staleBefore,
			recentAfter,
			now,
		});

		expect(status).toBe("started");
		expect(row.recoveryAttemptCount).toBe(2);
		expect(row.recoveryClaimId).not.toBe("expired-claim");
		expect(row.recoveryLeaseExpiresAt).toEqual(
			new Date("2026-09-22T12:15:00.000Z"),
		);
		expect(mockStart).toHaveBeenCalledWith(expect.any(Function), [
			expect.objectContaining({ recoveryClaimId: row.recoveryClaimId }),
		]);
	});

	it("allows only one workflow start across concurrent recovery calls", async () => {
		const row = recoveryRow({ recoveryAttemptCount: 0 });
		const database = statefulUpdate(row);
		mockDb.mockReturnValue(database);
		const { recoverWebCandidate } = await import(
			"@/lib/video-processing-recovery"
		);
		const input = {
			videoId,
			userId: "user-1",
			rawFileKey: row.rawFileKey,
			bucketId: null,
			staleBefore,
			recentAfter,
			now,
		};

		const statuses = await Promise.all([
			recoverWebCandidate(input),
			recoverWebCandidate(input),
		]);

		expect(statuses.sort()).toEqual(["already-claimed", "started"]);
		expect(mockStart).toHaveBeenCalledTimes(1);
		expect(row.recoveryAttemptCount).toBe(1);
	});

	it("preserves a consumed attempt and schedules rather than immediately looping when start fails", async () => {
		const row = recoveryRow({ recoveryAttemptCount: 0 });
		mockDb.mockReturnValue(statefulUpdate(row));
		mockStart.mockRejectedValueOnce(new Error("workflow service unavailable"));
		const { recoverWebCandidate } = await import(
			"@/lib/video-processing-recovery"
		);
		const input = {
			videoId,
			userId: "user-1",
			rawFileKey: row.rawFileKey,
			bucketId: null,
			staleBefore,
			recentAfter,
			now,
		};

		const firstStatus = await recoverWebCandidate(input);
		const claimId = row.recoveryClaimId;
		const secondStatus = await recoverWebCandidate(input);

		expect(firstStatus).toBe("retry-scheduled");
		expect(secondStatus).toBe("already-claimed");
		expect(mockStart).toHaveBeenCalledTimes(1);
		expect(row.recoveryAttemptCount).toBe(1);
		expect(row.recoveryClaimId).toBe(claimId);
		expect(row.processingMessage).toBe(
			"Processing recovery will retry automatically",
		);
		expect(row.processingError).toContain("workflow service unavailable");
	});

	it.each([
		["grace", staleBefore, new Date("2026-09-22T10:00:00.000Z")],
		["maximum age", new Date("2026-09-22T11:45:00.000Z"), recentAfter],
	])(
		"includes the exact shutdown recovery %s boundary",
		async (_, updatedAt, startedAt) => {
			const row = recoveryRow({
				recoveryAttemptCount: 0,
				updatedAt,
				startedAt,
			});
			mockDb.mockReturnValue(statefulUpdate(row));
			const { recoverWebCandidate } = await import(
				"@/lib/video-processing-recovery"
			);

			const status = await recoverWebCandidate({
				videoId,
				userId: "user-1",
				rawFileKey: row.rawFileKey,
				bucketId: null,
				staleBefore,
				recentAfter,
				now,
			});

			expect(status).toBe("started");
		},
	);

	it.each([
		[
			"one millisecond before grace elapses",
			new Date(staleBefore.getTime() + 1),
			new Date("2026-09-22T10:00:00.000Z"),
		],
		[
			"one millisecond beyond maximum age",
			new Date("2026-09-22T11:45:00.000Z"),
			new Date(recentAfter.getTime() - 1),
		],
	])("excludes a shutdown recovery %s", async (_, updatedAt, startedAt) => {
		const row = recoveryRow({
			recoveryAttemptCount: 0,
			updatedAt,
			startedAt,
		});
		mockDb.mockReturnValue(statefulUpdate(row));
		const { recoverWebCandidate } = await import(
			"@/lib/video-processing-recovery"
		);

		const status = await recoverWebCandidate({
			videoId,
			userId: "user-1",
			rawFileKey: row.rawFileKey,
			bucketId: null,
			staleBefore,
			recentAfter,
			now,
		});

		expect(status).toBe("already-claimed");
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("terminalizes an expired final processing claim without a fourth dispatch", async () => {
		const row = recoveryRow({
			phase: "processing",
			processingError: "",
			recoveryAttemptCount: 3,
			recoveryClaimId: "final-claim",
			recoveryLeaseExpiresAt: now,
		});
		mockDb.mockReturnValue(statefulUpdate(row));
		const { recoverWebCandidate, releaseExpiredWebRecoveryClaims } =
			await import("@/lib/video-processing-recovery");

		await releaseExpiredWebRecoveryClaims(now);
		const status = await recoverWebCandidate({
			videoId,
			userId: "user-1",
			rawFileKey: row.rawFileKey,
			bucketId: null,
			staleBefore,
			recentAfter,
			now,
		});

		expect(status).toBe("already-claimed");
		expect(row.phase).toBe("error");
		expect(row.recoveryAttemptCount).toBe(3);
		expect(row.recoveryClaimId).toBeNull();
		expect(row.recoveryLeaseExpiresAt).toBeNull();
		expect(row.processingMessage).toContain("exhausted");
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("terminalizes an expired final claim that never entered processing", async () => {
		const row = recoveryRow({
			phase: "error",
			processingError: "workflow recovery start failed",
			recoveryAttemptCount: 3,
			recoveryClaimId: "final-claim",
			recoveryLeaseExpiresAt: now,
		});
		mockDb.mockReturnValue(statefulUpdate(row));
		const { recoverWebCandidate, releaseExpiredWebRecoveryClaims } =
			await import("@/lib/video-processing-recovery");

		await releaseExpiredWebRecoveryClaims(now);
		const status = await recoverWebCandidate({
			videoId,
			userId: "user-1",
			rawFileKey: row.rawFileKey,
			bucketId: null,
			staleBefore,
			recentAfter,
			now,
		});

		expect(status).toBe("already-claimed");
		expect(row.phase).toBe("error");
		expect(row.recoveryClaimId).toBeNull();
		expect(row.recoveryLeaseExpiresAt).toBeNull();
		expect(row.processingMessage).toContain("exhausted");
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("makes a crashed processing claim recoverable only after its lease expires", async () => {
		const row = recoveryRow({
			phase: "processing",
			processingError: "",
			recoveryAttemptCount: 1,
			recoveryClaimId: "crashed-claim",
			recoveryLeaseExpiresAt: now,
		});
		mockDb.mockReturnValue(statefulUpdate(row));
		const { recoverWebCandidate, releaseExpiredWebRecoveryClaims } =
			await import("@/lib/video-processing-recovery");

		await releaseExpiredWebRecoveryClaims(now);
		const status = await recoverWebCandidate({
			videoId,
			userId: "user-1",
			rawFileKey: row.rawFileKey,
			bucketId: null,
			staleBefore,
			recentAfter,
			now,
		});

		expect(status).toBe("started");
		expect(row.recoveryAttemptCount).toBe(2);
		expect(row.processingError).toContain("workflow recovery requested");
	});
});

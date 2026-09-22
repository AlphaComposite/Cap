import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	dbCall: 0,
	row: {} as Record<string, unknown>,
	start: vi.fn(),
}));

type Expression = { op: string; args: unknown[] };
const expression = (op: string, ...args: unknown[]): Expression => ({
	op,
	args,
});
const isExpression = (value: unknown): value is Expression =>
	typeof value === "object" && value !== null && "op" in value;

vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => expression("and", ...args),
	asc: (value: unknown) => value,
	eq: (...args: unknown[]) => expression("eq", ...args),
	gte: (...args: unknown[]) => expression("gte", ...args),
	inArray: (...args: unknown[]) => expression("inArray", ...args),
	isNotNull: (...args: unknown[]) => expression("isNotNull", ...args),
	isNull: (...args: unknown[]) => expression("isNull", ...args),
	like: (...args: unknown[]) => expression("like", ...args),
	lt: (...args: unknown[]) => expression("lt", ...args),
	lte: (...args: unknown[]) => expression("lte", ...args),
	notLike: (...args: unknown[]) => expression("notLike", ...args),
	or: (...args: unknown[]) => expression("or", ...args),
	sql: (strings: TemplateStringsArray, ...args: unknown[]) =>
		strings.join("").includes("+ 1")
			? expression("increment", ...args)
			: expression("sql", strings, ...args),
}));

vi.mock("@cap/database/schema", () => ({
	importedVideos: {
		id: "importedId",
		orgId: "importedOrgId",
		source: "importedSource",
		sourceId: "loomVideoId",
	},
	users: {
		id: "userId",
		stripeSubscriptionStatus: "stripeSubscriptionStatus",
		thirdPartyStripeSubscriptionId: "thirdPartyStripeSubscriptionId",
	},
	videos: {
		id: "videoId",
		ownerId: "userId",
		orgId: "orgId",
		bucket: "bucketId",
		source: "source",
		metadata: "metadata",
		transcriptionStatus: "transcriptionStatus",
		isScreenshot: "isScreenshot",
		createdAt: "createdAt",
		updatedAt: "videoUpdatedAt",
	},
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

function value(operand: unknown) {
	return typeof operand === "string" && operand in mocks.row
		? mocks.row[operand]
		: operand;
}

function evaluate(condition: unknown): boolean {
	if (!isExpression(condition)) return true;
	const { op, args } = condition;
	if (op === "and") return args.every(evaluate);
	if (op === "or") return args.some(evaluate);
	if (op === "sql") return true;
	const left = value(args[0]);
	const right = value(args[1]);
	if (op === "eq") return left === right;
	if (op === "isNull") return left === null;
	if (op === "isNotNull") return left !== null;
	if (op === "inArray") return Array.isArray(right) && right.includes(left);
	if (op === "like" || op === "notLike") {
		const matches = String(left).includes(String(right).replaceAll("%", ""));
		return op === "like" ? matches : !matches;
	}
	if (op === "lt" || op === "lte" || op === "gte") {
		const a = left instanceof Date ? left.getTime() : Number(left);
		const b = right instanceof Date ? right.getTime() : Number(right);
		return op === "lt" ? a < b : op === "lte" ? a <= b : a >= b;
	}
	throw new Error(`Unsupported expression ${op}`);
}

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => {
			const call = ++mocks.dbCall;
			let condition: unknown;
			const chain = {
				from: () => chain,
				innerJoin: () => chain,
				leftJoin: () => chain,
				where: (next: unknown) => {
					condition = next;
					return chain;
				},
				orderBy: () => chain,
				limit: async () => {
					if (call !== 1 || !evaluate(condition)) return [];
					return [
						{
							videoId: mocks.row.videoId,
							userId: mocks.row.userId,
							bucketId: mocks.row.bucketId,
							rawFileKey: mocks.row.rawFileKey,
							loomVideoId: null,
							processingMessage: mocks.row.processingMessage,
							updatedAt: mocks.row.updatedAt,
						},
					];
				},
			};
			return chain;
		},
		update: () => {
			let changes: Record<string, unknown> = {};
			const chain = {
				set: (next: Record<string, unknown>) => {
					changes = next;
					return chain;
				},
				where: async (condition: unknown) => {
					if (!evaluate(condition)) return [{ affectedRows: 0 }];
					for (const [key, next] of Object.entries(changes)) {
						mocks.row[key] =
							isExpression(next) && next.op === "increment"
								? Number(value(next.args[0])) + 1
								: next;
					}
					return [{ affectedRows: 1 }];
				},
			};
			return chain;
		},
	}),
}));

vi.mock("@cap/env", () => ({ buildEnv: { NEXT_PUBLIC_IS_CAP: true } }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));
vi.mock("@/lib/generate-ai", () => ({ startAiGeneration: vi.fn() }));
vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: () => false,
}));
vi.mock("@/lib/ai-chapter-state", () => ({
	hasValidChapterState: () => false,
}));
vi.mock("@/workflows/process-video", () => ({ processVideoWorkflow: vi.fn() }));
vi.mock("@/workflows/import-loom-video", () => ({
	importLoomVideoWorkflow: vi.fn(),
}));

import { recoverStalledVideoPipeline } from "@/lib/video-pipeline-recovery";
import { recoverWebCandidate } from "@/lib/video-processing-recovery";

const now = new Date("2026-09-22T12:00:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.dbCall = 0;
	mocks.start.mockResolvedValue({ runId: "run-1" });
	mocks.row = {
		videoId: "video-1",
		userId: "user-1",
		orgId: "org-1",
		bucketId: null,
		source: { type: "webMP4" },
		phase: "error",
		processingProgress: 0,
		processingMessage: "Processing recovery will retry automatically",
		processingError: "Server shutting down",
		rawFileKey: "user-1/video-1/raw.mp4",
		startedAt: new Date("2026-09-22T10:00:00.000Z"),
		updatedAt: new Date("2026-09-22T10:30:00.000Z"),
		recoveryAttemptCount: 0,
		recoveryClaimId: null,
		recoveryLeaseExpiresAt: null,
	};
});

describe("Task 7 cross-path recovery ownership", () => {
	it("lets both cron recovery mechanisms start only the Task 7 claim owner", async () => {
		let releaseStart: (() => void) | undefined;
		let markStartEntered: (() => void) | undefined;
		const startEntered = new Promise<void>((resolve) => {
			markStartEntered = resolve;
		});
		const startBlocked = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		mocks.start.mockImplementationOnce(async () => {
			Object.assign(mocks.row, {
				phase: "processing",
				processingMessage: "Starting video processing...",
				updatedAt: new Date("2026-09-22T11:00:00.000Z"),
			});
			markStartEntered?.();
			await startBlocked;
			return { runId: "run-1" };
		});

		const ownerRecovery = recoverWebCandidate({
			videoId: "video-1" as never,
			userId: "user-1",
			rawFileKey: mocks.row.rawFileKey as string,
			bucketId: null,
			staleBefore: new Date("2026-09-22T11:50:00.000Z"),
			recentAfter: new Date("2026-09-20T12:00:00.000Z"),
			now,
		});
		await startEntered;
		const ownerClaimId = mocks.row.recoveryClaimId;

		mocks.dbCall = 0;
		const stalled = await recoverStalledVideoPipeline({ now, concurrency: 1 });
		releaseStart?.();
		const status = await ownerRecovery;

		expect(status).toBe("started");
		expect(ownerClaimId).toEqual(expect.any(String));
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(mocks.start).toHaveBeenCalledWith(expect.any(Function), [
			expect.objectContaining({ recoveryClaimId: ownerClaimId }),
		]);
		expect(stalled.media.checked).toBe(0);
	});
});

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	afterSelect: undefined as
		| undefined
		| ((kind: "owner" | "upload" | "video") => void),
	afterUploadUpdate: undefined as
		| undefined
		| ((changes: Record<string, unknown>) => void),
	beforeTransaction: undefined as undefined | (() => void),
	beforeVideoUpdate: undefined as undefined | (() => void),
	fetch: vi.fn(),
	get: vi.fn(),
	put: vi.fn(),
	remove: vi.fn(),
	transcribe: vi.fn(),
	waitForProcessing: vi.fn(),
	upload: null as null | Record<string, unknown>,
	video: null as null | Record<string, unknown>,
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
	eq: (...args: unknown[]) => expression("eq", ...args),
	gt: (...args: unknown[]) => expression("gt", ...args),
	or: (...args: unknown[]) => expression("or", ...args),
	sql: (strings: TemplateStringsArray, ...args: unknown[]) =>
		expression("activeRecoveryExists", strings, ...args),
}));

vi.mock("@cap/database/schema", () => ({
	users: {
		id: "users.id",
		stripeSubscriptionStatus: "users.stripeSubscriptionStatus",
		thirdPartyStripeSubscriptionId: "users.thirdPartyStripeSubscriptionId",
	},
	videos: { id: "videos.id", ownerId: "videos.ownerId" },
	videoUploads: {
		videoId: "videoId",
		phase: "phase",
		rawFileKey: "rawFileKey",
		recoveryClaimId: "recoveryClaimId",
		recoveryLeaseExpiresAt: "recoveryLeaseExpiresAt",
	},
}));

function operandValue(row: Record<string, unknown>, operand: unknown) {
	if (typeof operand !== "string") return operand;
	if (operand in row) return row[operand];
	const column = operand.split(".").at(-1);
	return column && column in row ? row[column] : operand;
}

function evaluate(row: Record<string, unknown>, condition: unknown): boolean {
	if (!isExpression(condition)) return true;
	if (condition.op === "and")
		return condition.args.every((item) => evaluate(row, item));
	if (condition.op === "or")
		return condition.args.some((item) => evaluate(row, item));
	const left = operandValue(row, condition.args[0]);
	const right = operandValue(row, condition.args[1]);
	if (condition.op === "eq") return left === right;
	if (condition.op === "gt") {
		return left instanceof Date && right instanceof Date
			? left > right
			: Number(left) > Number(right);
	}
	if (condition.op === "activeRecoveryExists") {
		return (
			mocks.upload !== null &&
			mocks.upload.videoId === "video" &&
			mocks.upload.phase === "processing" &&
			mocks.upload.rawFileKey === payload.rawFileKey &&
			mocks.upload.recoveryClaimId === payload.recoveryClaimId &&
			mocks.upload.recoveryLeaseExpiresAt instanceof Date &&
			mocks.upload.recoveryLeaseExpiresAt > new Date()
		);
	}
	throw new Error(`Unsupported expression ${condition.op}`);
}

vi.mock("@cap/database", () => ({
	db: () => {
		const database = {
			select: () => {
				let table: unknown;
				let joined = false;
				const chain = {
					from: (nextTable: unknown) => {
						table = nextTable;
						return chain;
					},
					innerJoin: () => {
						joined = true;
						return chain;
					},
					where: async () => {
						if (table && typeof table === "object" && "phase" in table) {
							mocks.afterSelect?.("upload");
							return mocks.upload ? [{ ...mocks.upload }] : [];
						}
						if (joined) {
							mocks.afterSelect?.("owner");
							return [
								{
									id: "owner",
									stripeSubscriptionStatus: "active",
									thirdPartyStripeSubscriptionId: null,
								},
							];
						}
						mocks.afterSelect?.("video");
						return mocks.video ? [{ ...mocks.video }] : [];
					},
				};
				return chain;
			},
			update: (table: unknown) => ({
				set: (changes: Record<string, unknown>) => ({
					where: async (condition: unknown) => {
						if (table && typeof table === "object" && "phase" in table) {
							if (!mocks.upload || !evaluate(mocks.upload, condition))
								return [{ affectedRows: 0 }];
							Object.assign(mocks.upload, changes);
							mocks.afterUploadUpdate?.(changes);
							return [{ affectedRows: 1 }];
						}
						mocks.beforeVideoUpdate?.();
						if (!mocks.video || !evaluate(mocks.video, condition))
							return [{ affectedRows: 0 }];
						Object.assign(mocks.video, changes);
						return [{ affectedRows: 1 }];
					},
				}),
			}),
			delete: () => ({
				where: async (condition: unknown) => {
					if (!mocks.upload || !evaluate(mocks.upload, condition))
						return [{ affectedRows: 0 }];
					mocks.upload = null;
					return [{ affectedRows: 1 }];
				},
			}),
		};
		return Object.assign(database, {
			transaction: async <T>(run: (tx: typeof database) => Promise<T>) => {
				mocks.beforeTransaction?.();
				return run(database);
			},
		});
	},
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		MEDIA_SERVER_URL: "https://worker.example.com",
		WEB_URL: "https://cap.example.com",
		MEDIA_SERVER_WEBHOOK_SECRET: "test-secret",
	}),
}));
vi.mock("@cap/web-domain", () => ({
	Video: { VideoId: { make: (id: string) => id } },
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					getInternalSignedObjectUrl: mocks.get,
					getInternalPresignedPutUrl: mocks.put,
					deleteObject: mocks.remove,
				},
			]),
	},
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: (effect: Effect.Effect<unknown>) =>
		Effect.runPromise(effect),
}));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: mocks.transcribe }));
vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: () => true,
}));
vi.mock("@/workflows/video-processing-status", () => ({
	VideoProcessingFailedError: class VideoProcessingFailedError extends Error {},
	waitForVideoProcessing: mocks.waitForProcessing,
}));
vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
	sleep: vi.fn(),
}));

import { processVideoWorkflow } from "@/workflows/process-video";

const now = new Date("2026-09-22T12:00:00.000Z");
const payload = {
	videoId: "video",
	userId: "owner",
	rawFileKey: "owner/video/raw-upload.mp4",
	bucketId: null,
	recoveryClaimId: "claim-1",
};
const metadata = { duration: 30, width: 1920, height: 1080, fps: 30 };

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
	mocks.afterSelect = undefined;
	mocks.afterUploadUpdate = undefined;
	mocks.beforeTransaction = undefined;
	mocks.beforeVideoUpdate = undefined;
	mocks.upload = {
		videoId: "video",
		phase: "error",
		rawFileKey: payload.rawFileKey,
		recoveryClaimId: "claim-1",
		recoveryLeaseExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
	};
	mocks.video = { id: "video", ownerId: "owner", source: { type: "webMP4" } };
	mocks.get
		.mockReset()
		.mockImplementation((key: string) =>
			Effect.succeed(`https://storage.example.com/${key}`),
		);
	mocks.put
		.mockReset()
		.mockImplementation((key: string) =>
			Effect.succeed(`https://storage.example.com/${key}?upload=1`),
		);
	mocks.remove.mockReset().mockImplementation(() => Effect.void);
	mocks.transcribe
		.mockReset()
		.mockResolvedValue({ success: true, message: "started" });
	mocks.waitForProcessing.mockReset().mockResolvedValue(metadata);
	mocks.fetch.mockReset().mockResolvedValue(Response.json({ jobId: "job-1" }));
	vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("processVideoWorkflow recovery claim lifecycle", () => {
	it("suppresses media dispatch when the lease expires after URL preparation", async () => {
		let putCount = 0;
		mocks.put.mockImplementation((key: string) => {
			putCount++;
			if (putCount === 3)
				mocks.beforeTransaction = () => {
					if (mocks.upload) mocks.upload.recoveryLeaseExpiresAt = now;
				};
			return Effect.succeed(`https://storage.example.com/${key}?upload=1`);
		});

		await expect(processVideoWorkflow(payload)).rejects.toThrow(
			"recovery claim is no longer active",
		);

		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.get).toHaveBeenCalledOnce();
		expect(mocks.remove).not.toHaveBeenCalled();
		expect(mocks.transcribe).not.toHaveBeenCalled();
		expect(mocks.upload?.phase).toBe("processing");
	});

	it("suppresses metadata mutation when the claim is replaced after renewal", async () => {
		let processingFinished = false;
		mocks.waitForProcessing.mockImplementation(async () => {
			processingFinished = true;
			return metadata;
		});
		mocks.afterUploadUpdate = () => {
			if (!processingFinished || !mocks.upload) return;
			mocks.afterUploadUpdate = undefined;
			mocks.upload.recoveryClaimId = "claim-2";
		};

		await expect(processVideoWorkflow(payload)).rejects.toThrow(
			"recovery claim is no longer active",
		);

		expect(mocks.fetch).toHaveBeenCalledOnce();
		expect(mocks.video).not.toMatchObject(metadata);
		expect(mocks.remove).not.toHaveBeenCalled();
		expect(mocks.transcribe).not.toHaveBeenCalled();
		expect(mocks.upload?.recoveryClaimId).toBe("claim-2");
	});

	it("suppresses raw deletion when the raw key changes after cleanup preparation", async () => {
		let videoSelects = 0;
		mocks.afterSelect = (kind) => {
			if (kind !== "video" || ++videoSelects !== 3 || !mocks.upload) return;
			mocks.beforeTransaction = () => {
				if (mocks.upload)
					mocks.upload.rawFileKey = "owner/video/replaced-upload.mp4";
			};
		};

		await expect(processVideoWorkflow(payload)).rejects.toThrow(
			"recovery claim is no longer active",
		);

		expect(mocks.remove).not.toHaveBeenCalled();
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it("suppresses transcription when the upload leaves processing after owner lookup", async () => {
		mocks.afterSelect = (kind) => {
			if (kind !== "owner" || !mocks.upload) return;
			mocks.upload.phase = "error";
		};

		await expect(processVideoWorkflow(payload)).rejects.toThrow(
			"recovery claim is no longer active",
		);

		expect(mocks.remove).toHaveBeenCalledOnce();
		expect(mocks.transcribe).not.toHaveBeenCalled();
		expect(mocks.upload?.phase).toBe("error");
	});

	it("lets the unexpired owner renew and complete every guarded step", async () => {
		mocks.fetch.mockResolvedValueOnce(Response.json({ jobId: "job-1" }));

		await expect(processVideoWorkflow(payload)).resolves.toMatchObject({
			success: true,
			metadata,
		});

		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		expect(mocks.get).toHaveBeenCalledTimes(1);
		expect(mocks.remove).toHaveBeenCalledWith(payload.rawFileKey);
		expect(mocks.transcribe).toHaveBeenCalledWith("video", "owner", true);
		expect(mocks.video).toMatchObject(metadata);
		expect(mocks.upload).toBeNull();
	});
});

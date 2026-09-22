import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	afterOwnerLookup: undefined as undefined | (() => void),
	afterUploadLookup: undefined as undefined | (() => void),
	afterVideoUpdate: undefined as undefined | (() => void),
	fetch: vi.fn(),
	get: vi.fn(),
	put: vi.fn(),
	remove: vi.fn(),
	start: vi.fn(),
	upload: null as null | Record<string, unknown>,
	video: null as null | Record<string, unknown>,
	waitForProcessing: vi.fn(),
	inTransaction: false,
	pendingUploadReplacement: undefined as
		| undefined
		| (null | Record<string, unknown>),
}));

function replaceUpload(upload: null | Record<string, unknown>) {
	if (mocks.inTransaction) {
		mocks.pendingUploadReplacement = upload;
		return;
	}
	mocks.upload = upload;
}

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
	isNull: (...args: unknown[]) => expression("isNull", ...args),
	sql: (strings: TemplateStringsArray, ...args: unknown[]) =>
		expression("activeRecoveryExists", strings, ...args),
}));

const schema = vi.hoisted(() => ({
	organizations: { id: "organizations.id", settings: "organizations.settings" },
	users: {
		id: "users.id",
		stripeSubscriptionStatus: "users.stripeSubscriptionStatus",
		thirdPartyStripeSubscriptionId: "users.thirdPartyStripeSubscriptionId",
	},
	videos: {
		id: "videos.id",
		metadata: "videos.metadata",
		orgId: "videos.orgId",
		ownerId: "videos.ownerId",
		settings: "videos.settings",
		transcriptionStatus: "videos.transcriptionStatus",
	},
	videoUploads: {
		videoId: "videoUploads.videoId",
		phase: "videoUploads.phase",
		rawFileKey: "videoUploads.rawFileKey",
		recoveryClaimId: "videoUploads.recoveryClaimId",
		recoveryLeaseExpiresAt: "videoUploads.recoveryLeaseExpiresAt",
	},
}));

vi.mock("@cap/database/schema", () => schema);

function operandValue(row: Record<string, unknown>, operand: unknown) {
	if (typeof operand !== "string") return operand;
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
	if (condition.op === "isNull") return left == null;
	if (condition.op === "gt") {
		return left instanceof Date && right instanceof Date
			? left > right
			: Number(left) > Number(right);
	}
	if (condition.op === "activeRecoveryExists") {
		return (
			mocks.upload?.phase === "processing" &&
			mocks.upload.rawFileKey === payload.rawFileKey &&
			mocks.upload.recoveryClaimId === "claim-1" &&
			mocks.upload.recoveryLeaseExpiresAt instanceof Date &&
			mocks.upload.recoveryLeaseExpiresAt > new Date()
		);
	}
	throw new Error(`Unsupported expression ${condition.op}`);
}

vi.mock("@cap/database", () => ({
	db: () => {
		const database = {
			select: (selection?: Record<string, unknown>) => {
				let table: unknown;
				let innerJoined = false;
				let leftJoined = false;
				const resolve = () => {
					if (table === schema.videoUploads) {
						if (!mocks.upload) return [];
						const rows = selection
							? [{ phase: mocks.upload.phase }]
							: [{ ...mocks.upload }];
						mocks.afterUploadLookup?.();
						return rows;
					}
					if (innerJoined) {
						mocks.afterOwnerLookup?.();
						return [
							{
								id: "owner",
								stripeSubscriptionStatus: "active",
								thirdPartyStripeSubscriptionId: null,
							},
						];
					}
					if (!mocks.video) return [];
					if (leftJoined) {
						return [
							{
								video: { ...mocks.video },
								settings: mocks.video.settings ?? null,
								orgSettings: null,
							},
						];
					}
					return [{ ...mocks.video }];
				};
				const chain = {
					from: (nextTable: unknown) => {
						table = nextTable;
						return chain;
					},
					innerJoin: () => {
						innerJoined = true;
						return chain;
					},
					leftJoin: () => {
						leftJoined = true;
						return chain;
					},
					where: () => {
						const rows = resolve();
						return Object.assign(Promise.resolve(rows), {
							limit: async (count: number) => rows.slice(0, count),
						});
					},
				};
				return chain;
			},
			update: (table: unknown) => ({
				set: (changes: Record<string, unknown>) => ({
					where: async (condition: unknown) => {
						const row =
							table === schema.videoUploads ? mocks.upload : mocks.video;
						if (!row || !evaluate(row, condition)) return [{ affectedRows: 0 }];
						Object.assign(row, changes);
						if (table === schema.videos) mocks.afterVideoUpdate?.();
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
				mocks.inTransaction = true;
				try {
					return await run(database);
				} finally {
					mocks.inTransaction = false;
					if (mocks.pendingUploadReplacement !== undefined) {
						mocks.upload = mocks.pendingUploadReplacement;
						mocks.pendingUploadReplacement = undefined;
					}
				}
			},
		});
	},
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		ASSEMBLY_API_KEY: "assembly-key",
		MEDIA_SERVER_URL: "https://worker.example.com",
		WEB_URL: "https://cap.example.com",
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
vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: () => true,
}));
vi.mock("@/workflows/video-processing-status", () => ({
	VideoProcessingFailedError: class VideoProcessingFailedError extends Error {},
	waitForVideoProcessing: mocks.waitForProcessing,
}));
vi.mock("@/workflows/transcribe", () => ({ transcribeVideoWorkflow: vi.fn() }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
	RetryableError: class RetryableError extends Error {},
	sleep: vi.fn(),
}));

import { processVideoWorkflow } from "@/workflows/process-video";
import { transcribeVideoWorkflow } from "@/workflows/transcribe";

const now = new Date("2026-09-22T12:00:00.000Z");
const payload = {
	videoId: "video",
	userId: "owner",
	rawFileKey: "owner/video/raw-upload.mp4",
	bucketId: null,
};
const metadata = { duration: 30, width: 1920, height: 1080, fps: 30 };

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
	mocks.afterOwnerLookup = undefined;
	mocks.afterUploadLookup = undefined;
	mocks.afterVideoUpdate = undefined;
	mocks.inTransaction = false;
	mocks.pendingUploadReplacement = undefined;
	mocks.upload = {
		videoId: "video",
		phase: "processing",
		rawFileKey: payload.rawFileKey,
		recoveryClaimId: null,
		recoveryLeaseExpiresAt: null,
	};
	mocks.video = {
		id: "video",
		ownerId: "owner",
		orgId: null,
		settings: null,
		metadata: null,
		transcriptionStatus: null,
		source: { type: "webMP4" },
	};
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
	mocks.fetch.mockReset().mockResolvedValue(Response.json({ jobId: "job-1" }));
	mocks.start.mockReset().mockResolvedValue({ id: "transcription-run" });
	mocks.waitForProcessing.mockReset().mockResolvedValue(metadata);
	vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("processVideoWorkflow transcription handoff", () => {
	it("normal processing passes the real active-upload guard and dispatches transcription", async () => {
		await expect(processVideoWorkflow(payload)).resolves.toMatchObject({
			success: true,
		});

		expect(mocks.start).toHaveBeenCalledWith(transcribeVideoWorkflow, [
			{ videoId: "video", userId: "owner", aiGenerationEnabled: true },
		]);
		expect(mocks.video?.transcriptionStatus).toBe("PROCESSING");
		expect(mocks.upload).toBeNull();
	});

	it("does not mutate or dispatch a replacement after normal validation", async () => {
		const replacement = {
			videoId: "video",
			phase: "uploading",
			rawFileKey: "owner/video/replacement.mp4",
			recoveryClaimId: null,
			recoveryLeaseExpiresAt: null,
		};
		mocks.afterUploadLookup = () => {
			mocks.afterUploadLookup = undefined;
			mocks.upload = replacement;
		};

		await expect(processVideoWorkflow(payload)).rejects.toThrow(
			"Video upload identity is no longer active",
		);

		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.remove).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.upload).toEqual(replacement);
	});

	it("cannot resume after recovery claims the same raw upload", async () => {
		const originalVideo = { ...mocks.video };
		const recoveryOwnedUpload = {
			videoId: "video",
			phase: "processing",
			rawFileKey: payload.rawFileKey,
			recoveryClaimId: "claim-1",
			recoveryLeaseExpiresAt: new Date(now.getTime() + 90 * 60 * 1000),
			processingProgress: 37,
			processingMessage: "Recovery processing video",
			processingError: null,
		};
		const expectedRecoveryOwnedUpload = { ...recoveryOwnedUpload };
		mocks.afterUploadLookup = () => {
			mocks.afterUploadLookup = undefined;
			mocks.upload = recoveryOwnedUpload;
		};

		await expect(processVideoWorkflow(payload)).rejects.toThrow(
			"Video upload identity is no longer active",
		);

		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.video).toEqual(originalVideo);
		expect(mocks.remove).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.upload).toEqual(expectedRecoveryOwnedUpload);
	});

	it("suppresses normal media dispatch after replacement during signed URL preparation", async () => {
		const replacement = {
			videoId: "video",
			phase: "uploading",
			rawFileKey: "owner/video/replacement.mp4",
			recoveryClaimId: null,
			recoveryLeaseExpiresAt: null,
		};
		let putCount = 0;
		mocks.put.mockImplementation((key: string) => {
			putCount++;
			if (putCount === 3) replaceUpload(replacement);
			return Effect.succeed(`https://storage.example.com/${key}?upload=1`);
		});

		await expect(processVideoWorkflow(payload)).rejects.toThrow(
			"Video upload identity is no longer active",
		);

		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.upload).toEqual(replacement);
	});

	it("does not mark a replacement after a delayed normal capacity response", async () => {
		const replacement = {
			videoId: "video",
			phase: "uploading",
			rawFileKey: "owner/video/replacement.mp4",
			recoveryClaimId: null,
			recoveryLeaseExpiresAt: null,
			processingMessage: "Uploading replacement",
			processingError: "replacement state",
		};
		const expectedReplacement = { ...replacement };
		mocks.fetch
			.mockResolvedValueOnce(
				Response.json(
					{ error: "Server is busy", code: "SERVER_BUSY" },
					{ status: 503 },
				),
			)
			.mockImplementationOnce(async () => {
				replaceUpload(replacement);
				return Response.json(
					{ error: "Server is busy", code: "SERVER_BUSY" },
					{ status: 503 },
				);
			});

		const processing = processVideoWorkflow(payload);
		const rejection = expect(processing).rejects.toThrow(
			"Video upload identity is no longer active",
		);
		await vi.advanceTimersByTimeAsync(250);
		await rejection;

		expect(mocks.fetch).toHaveBeenCalledTimes(2);
		expect(mocks.upload).toEqual(expectedReplacement);
	});

	it("does not error a same-key replacement in a different phase", async () => {
		const replacement = {
			videoId: "video",
			phase: "uploading",
			rawFileKey: payload.rawFileKey,
			recoveryClaimId: null,
			recoveryLeaseExpiresAt: null,
			processingMessage: "Uploading replacement",
			processingError: null,
		};
		const expectedReplacement = { ...replacement };
		mocks.fetch.mockImplementationOnce(async () => {
			replaceUpload(replacement);
			return Response.json({ error: "Worker failed" }, { status: 500 });
		});

		await expect(processVideoWorkflow(payload)).rejects.toThrow(
			"Worker failed",
		);

		expect(mocks.fetch).toHaveBeenCalledOnce();
		expect(mocks.upload).toEqual(expectedReplacement);
	});

	it("does not transcribe or delete a replacement upload at normal handoff", async () => {
		const replacement = {
			videoId: "video",
			phase: "processing",
			rawFileKey: "owner/video/replacement.mp4",
			recoveryClaimId: null,
			recoveryLeaseExpiresAt: null,
		};
		mocks.afterOwnerLookup = () => {
			mocks.afterOwnerLookup = undefined;
			mocks.upload = replacement;
		};

		await expect(processVideoWorkflow(payload)).rejects.toThrow(
			"Video upload identity is no longer active",
		);

		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.video?.transcriptionStatus).toBeNull();
		expect(mocks.upload).toEqual(replacement);
	});

	it("does not mutate media or delete raw data after normal identity replacement", async () => {
		const originalVideo = { ...mocks.video };
		const replacement = {
			videoId: "video",
			phase: "processing",
			rawFileKey: "owner/video/replacement.mp4",
			recoveryClaimId: null,
			recoveryLeaseExpiresAt: null,
		};
		mocks.waitForProcessing.mockImplementation(async () => {
			mocks.upload = replacement;
			return metadata;
		});

		await expect(processVideoWorkflow(payload)).rejects.toThrow(
			"Video upload identity is no longer active",
		);

		expect(mocks.video).toEqual(originalVideo);
		expect(mocks.remove).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.upload).toEqual(replacement);
	});

	it("does not delete raw data after replacement before normal cleanup", async () => {
		const replacement = {
			videoId: "video",
			phase: "processing",
			rawFileKey: "owner/video/replacement.mp4",
			recoveryClaimId: null,
			recoveryLeaseExpiresAt: null,
		};
		mocks.afterVideoUpdate = () => {
			mocks.afterVideoUpdate = undefined;
			mocks.upload = replacement;
		};

		await expect(processVideoWorkflow(payload)).rejects.toThrow(
			"Video upload identity is no longer active",
		);

		expect(mocks.remove).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.upload).toEqual(replacement);
	});

	it("does not delete a replacement upload during normal late cleanup", async () => {
		const replacement = {
			videoId: "video",
			phase: "processing",
			rawFileKey: "owner/video/replacement.mp4",
			recoveryClaimId: null,
			recoveryLeaseExpiresAt: null,
		};
		mocks.start.mockImplementation(async () => {
			mocks.upload = replacement;
			return { id: "transcription-run" };
		});

		await expect(processVideoWorkflow(payload)).resolves.toMatchObject({
			success: true,
		});

		expect(mocks.start).toHaveBeenCalledOnce();
		expect(mocks.upload).toEqual(replacement);
	});

	it("recovery processing passes the real active-upload guard and dispatches transcription", async () => {
		mocks.upload = {
			...mocks.upload,
			phase: "error",
			recoveryClaimId: "claim-1",
			recoveryLeaseExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
		};
		mocks.start.mockImplementation(async () => {
			expect(mocks.upload).toMatchObject({
				phase: "complete",
				recoveryClaimId: "claim-1",
			});
			return { id: "transcription-run" };
		});

		await expect(
			processVideoWorkflow({ ...payload, recoveryClaimId: "claim-1" }),
		).resolves.toMatchObject({ success: true });

		expect(mocks.start).toHaveBeenCalledOnce();
		expect(mocks.video?.transcriptionStatus).toBe("PROCESSING");
		expect(mocks.upload).toBeNull();
	});

	it("does not dispatch an expired recovery complete handoff", async () => {
		mocks.upload = {
			...mocks.upload,
			phase: "error",
			recoveryClaimId: "claim-1",
			recoveryLeaseExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
		};
		mocks.afterOwnerLookup = () => {
			mocks.afterOwnerLookup = undefined;
			if (mocks.upload) {
				mocks.upload.phase = "complete";
				mocks.upload.recoveryLeaseExpiresAt = new Date(now.getTime() - 1);
			}
		};

		await expect(
			processVideoWorkflow({ ...payload, recoveryClaimId: "claim-1" }),
		).rejects.toThrow("recovery claim is no longer active");

		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.video?.transcriptionStatus).toBeNull();
	});

	it("allows an unexpired recovery complete handoff retry", async () => {
		mocks.upload = {
			...mocks.upload,
			phase: "error",
			recoveryClaimId: "claim-1",
			recoveryLeaseExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
		};
		mocks.afterOwnerLookup = () => {
			mocks.afterOwnerLookup = undefined;
			if (mocks.upload) mocks.upload.phase = "complete";
		};

		await expect(
			processVideoWorkflow({ ...payload, recoveryClaimId: "claim-1" }),
		).resolves.toMatchObject({ success: true });

		expect(mocks.start).toHaveBeenCalledOnce();
	});

	it("does not finalize or dispatch when recovery ownership is replaced at handoff", async () => {
		mocks.upload = {
			...mocks.upload,
			phase: "error",
			recoveryClaimId: "claim-1",
			recoveryLeaseExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
		};
		mocks.afterOwnerLookup = () => {
			mocks.afterOwnerLookup = undefined;
			if (mocks.upload) mocks.upload.recoveryClaimId = "claim-2";
		};

		await expect(
			processVideoWorkflow({ ...payload, recoveryClaimId: "claim-1" }),
		).rejects.toThrow("recovery claim is no longer active");

		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.video?.transcriptionStatus).toBeNull();
		expect(mocks.upload).toMatchObject({
			phase: "processing",
			recoveryClaimId: "claim-2",
		});
	});

	it("does not delete a replaced upload during idempotent late cleanup", async () => {
		mocks.upload = {
			...mocks.upload,
			phase: "error",
			recoveryClaimId: "claim-1",
			recoveryLeaseExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
		};
		mocks.start.mockImplementation(async () => {
			mocks.upload = {
				videoId: "video",
				phase: "processing",
				rawFileKey: "owner/video/replacement.mp4",
				recoveryClaimId: "claim-2",
				recoveryLeaseExpiresAt: new Date(now.getTime() + 90 * 60 * 1000),
			};
			return { id: "transcription-run" };
		});

		await expect(
			processVideoWorkflow({ ...payload, recoveryClaimId: "claim-1" }),
		).resolves.toMatchObject({ success: true });

		expect(mocks.start).toHaveBeenCalledOnce();
		expect(mocks.upload).toMatchObject({
			phase: "processing",
			rawFileKey: "owner/video/replacement.mp4",
			recoveryClaimId: "claim-2",
		});
	});
});

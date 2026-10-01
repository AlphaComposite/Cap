import {
	revisionOutbox,
	users,
	videoProcessingJobs,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { Effect } from "effect";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	fetch: vi.fn(),
	get: vi.fn(),
	now: 0,
	put: vi.fn(),
	remove: vi.fn(),
	sleep: vi.fn(),
	start: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("drizzle-orm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm")>();
	const expression = (op: string, args: unknown[]) => ({ op, args });
	return {
		...actual,
		and: (...args: unknown[]) =>
			expression(
				"and",
				args.filter((item) => item !== undefined),
			),
		or: (...args: unknown[]) =>
			expression(
				"or",
				args.filter((item) => item !== undefined),
			),
		eq: (left: unknown, right: unknown) => expression("eq", [left, right]),
		gt: (left: unknown, right: unknown) => expression("gt", [left, right]),
		isNull: (value: unknown) => expression("isNull", [value]),
	};
});

vi.mock("@cap/database", () => ({
	db: () => database,
}));

vi.mock("@cap/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/env")>();
	return {
		...actual,
		serverEnv: () => ({
			ASSEMBLY_API_KEY: "assembly-key",
			MEDIA_SERVER_URL: "https://worker.example.com",
			MEDIA_SERVER_WEBHOOK_SECRET: "media-secret",
			MEDIA_SERVER_WEBHOOK_URL: "https://cap.example.com",
			WEB_URL: "https://cap.example.com",
		}),
	};
});

vi.mock("@/lib/server", async () => ({
	runPromise: (await import("effect")).Effect.runPromise,
}));

vi.mock("@/workflows/transcribe", () => ({
	transcribeVideoWorkflow: vi.fn(),
}));

vi.mock("workflow/api", () => ({
	start: mocks.start,
}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
	sleep: (delay: number | string) => mocks.sleep(delay),
}));

vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					deleteObject: mocks.remove,
					getInternalPresignedPutUrl: mocks.put,
					getInternalSignedObjectUrl: mocks.get,
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

import { POST } from "@/app/api/webhooks/media-server/progress/route";
import { processVideoWorkflow } from "@/workflows/process-video";

type Expression = { op: string; args: unknown[] };
type Upload = {
	videoId: string;
	phase: string;
	processingProgress: number;
	processingMessage: string | null;
	processingError: string | null;
	rawFileKey: string | null;
	recoveryClaimId: string | null;
	recoveryLeaseExpiresAt: Date | null;
	updatedAt: Date;
};
type VideoRow = {
	id: string;
	ownerId: string;
	orgId: string | null;
	source: { type: string };
	width: number | null;
	height: number | null;
	fps: number | null;
	duration: number | null;
	transcriptionStatus: string | null;
	metadata: Record<string, unknown> | null;
	settings: null;
	storageIntegrationId: null;
	isScreenshot: boolean;
	name: string;
};

const tables = [
	videos,
	videoUploads,
	videoProcessingJobs,
	users,
	revisionOutbox,
];
const store = {
	beforeUploadUpdate: undefined as undefined | (() => void),
	outbox: [] as Array<Record<string, unknown>>,
	uploads: [] as Upload[],
	videos: [] as VideoRow[],
	users: [] as Array<{
		id: string;
		stripeSubscriptionStatus: string | null;
		thirdPartyStripeSubscriptionId: string | null;
	}>,
};

function isExpression(value: unknown): value is Expression {
	return (
		typeof value === "object" &&
		value !== null &&
		"op" in value &&
		"args" in value
	);
}

function columnKey(operand: unknown) {
	if (typeof operand === "string") return operand.split(".").at(-1);
	if (!operand || typeof operand !== "object") return undefined;
	for (const table of tables) {
		for (const [key, column] of Object.entries(table)) {
			if (column === operand) return key;
		}
	}
	return undefined;
}

function evaluate(row: Record<string, unknown>, condition: unknown): boolean {
	if (!isExpression(condition)) return true;
	if (condition.op === "and")
		return condition.args.every((item) => evaluate(row, item));
	if (condition.op === "or")
		return condition.args.some((item) => evaluate(row, item));
	const key = columnKey(condition.args[0]);
	const left = key ? row[key] : condition.args[0];
	const right = condition.args[1];
	if (condition.op === "eq") return left === right;
	if (condition.op === "isNull") return left == null;
	if (condition.op === "gt") {
		return left instanceof Date && right instanceof Date
			? left > right
			: Number(left) > Number(right);
	}
	throw new Error(`Unsupported expression ${condition.op}`);
}

function rowsFor(table: unknown) {
	if (table === videoUploads) return store.uploads;
	if (table === videos) return store.videos;
	if (table === users) return store.users;
	if (table === videoProcessingJobs) return [];
	if (table === revisionOutbox) return store.outbox;
	throw new Error(`Unexpected table ${String(table)}`);
}

function matching(table: unknown, condition: unknown) {
	return rowsFor(table).filter((row) =>
		evaluate(row as Record<string, unknown>, condition),
	);
}

const database = {
	select: () => {
		let table: unknown;
		let joined: "inner" | "left" | null = null;
		const chain = {
			from: (next: unknown) => {
				table = next;
				return chain;
			},
			innerJoin: () => {
				joined = "inner";
				return chain;
			},
			leftJoin: () => {
				joined = "left";
				return chain;
			},
			where: (condition: unknown) => {
				const rows = matching(table, condition);
				const resolved =
					joined === "left"
						? rows.map((row) => ({
								video: row,
								settings: (row as VideoRow).settings,
								orgSettings: null,
							}))
						: joined === "inner"
							? rows.flatMap((row) => {
									const video = row as VideoRow;
									const owner = store.users.find(
										(user) => user.id === video.ownerId,
									);
									return owner
										? [
												{
													id: owner.id,
													isScreenshot: video.isScreenshot,
													stripeSubscriptionStatus:
														owner.stripeSubscriptionStatus,
													thirdPartyStripeSubscriptionId:
														owner.thirdPartyStripeSubscriptionId,
												},
											]
										: [];
								})
							: rows;
				return Object.assign(Promise.resolve(resolved), {
					limit: (count: number) => Promise.resolve(resolved.slice(0, count)),
					for: () => Promise.resolve(resolved),
				});
			},
		};
		return chain;
	},
	update: (table: unknown) => ({
		set: (changes: Record<string, unknown>) => ({
			where: async (condition: unknown) => {
				if (table === videoUploads) store.beforeUploadUpdate?.();
				const rows = matching(table, condition);
				for (const row of rows) Object.assign(row, changes);
				return [{ affectedRows: rows.length }];
			},
		}),
	}),
	delete: (table: unknown) => ({
		where: async (condition: unknown) => {
			const rows = matching(table, condition);
			if (table === videoUploads) {
				store.uploads = store.uploads.filter((row) => !rows.includes(row));
			}
			return [{ affectedRows: rows.length }];
		},
	}),
	insert: (table: unknown) => ({
		values: async (row: Record<string, unknown>) => {
			if (table === revisionOutbox) store.outbox.push(row);
			return [{ affectedRows: 1 }];
		},
	}),
	transaction: async <T>(run: (tx: typeof database) => Promise<T>) =>
		run(database),
};

const ownerId = "owner-1";
const videoId = "video-1";
const siblingId = "video-2";
const rawFileKey = `${ownerId}/${videoId}/raw-upload.mp4`;
const metadata = {
	duration: 12,
	width: 1280,
	height: 720,
	fps: 30,
	videoCodec: "h264",
	audioCodec: "aac",
	audioChannels: 2,
	sampleRate: 48000,
	bitrate: 1_000_000,
	fileSize: 4096,
};

function videoRow(id: string): VideoRow {
	return {
		id,
		ownerId,
		orgId: null,
		source: { type: "webMP4" },
		width: null,
		height: null,
		fps: null,
		duration: null,
		transcriptionStatus: null,
		metadata: null,
		settings: null,
		storageIntegrationId: null,
		isScreenshot: false,
		name: id,
	};
}

function uploadRow(id: string, key: string): Upload {
	return {
		videoId: id,
		phase: "processing",
		processingProgress: 10,
		processingMessage: "Processing video...",
		processingError: null,
		rawFileKey: key,
		recoveryClaimId: null,
		recoveryLeaseExpiresAt: null,
		updatedAt: new Date("2026-10-01T12:00:00.000Z"),
	};
}

function postComplete(id = videoId) {
	return POST(
		new NextRequest(
			"https://cap.example.com/api/webhooks/media-server/progress",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-media-server-secret": "media-secret",
				},
				body: JSON.stringify({
					jobId: "job-1",
					videoId: id,
					phase: "complete",
					progress: 100,
					metadata,
				}),
			},
		),
	);
}

describe("webMP4 media completion handoff", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	beforeEach(() => {
		delete process.env.CAP_INSTANT_FINISH_OWNERS;
		store.beforeUploadUpdate = undefined;
		store.outbox = [];
		store.uploads = [
			uploadRow(videoId, rawFileKey),
			uploadRow(siblingId, `${ownerId}/${siblingId}/raw-upload.mp4`),
		];
		store.videos = [videoRow(videoId), videoRow(siblingId)];
		store.users = [
			{
				id: ownerId,
				stripeSubscriptionStatus: "active",
				thirdPartyStripeSubscriptionId: null,
			},
		];
		mocks.start.mockReset().mockResolvedValue({ id: "transcription-run" });
		mocks.now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => mocks.now);
		mocks.sleep
			.mockReset()
			.mockImplementation(async (delay: number | string) => {
				const parsed =
					typeof delay === "number"
						? delay
						: Number.parseInt(delay, 10) * 1_000;
				mocks.now += Number.isFinite(parsed) ? parsed : 5_000;
			});
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
		mocks.fetch.mockReset().mockImplementation(async () => {
			await postComplete();
			return Response.json({ jobId: "job-1" });
		});
		vi.stubGlobal("fetch", mocks.fetch);
		process.env.NEXT_PUBLIC_WEB_URL = "https://cap.example.com";
		process.env.WEB_URL = "https://cap.example.com";
	});

	it("retains the current webMP4 upload and does not queue transcription", async () => {
		const sibling = structuredClone(store.uploads[1]);
		const response = await postComplete();

		expect(response.status).toBe(200);
		expect(store.uploads.find((row) => row.videoId === videoId)).toMatchObject({
			phase: "processing",
			processingProgress: 100,
			processingError: null,
			rawFileKey,
			recoveryClaimId: null,
		});
		expect(mocks.start).not.toHaveBeenCalled();
		expect(store.outbox).toEqual([]);
		expect(store.uploads.find((row) => row.videoId === siblingId)).toEqual(
			sibling,
		);
	});

	it("cleans up the raw upload, dispatches transcription once, and deletes the row", async () => {
		const sibling = structuredClone(store.uploads[1]);

		await expect(
			processVideoWorkflow({
				videoId,
				userId: ownerId,
				rawFileKey,
				bucketId: null,
			}),
		).resolves.toMatchObject({ success: true });

		expect(mocks.remove).toHaveBeenCalledWith(rawFileKey);
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(
			store.uploads.find((row) => row.videoId === videoId),
		).toBeUndefined();
		expect(store.uploads.find((row) => row.videoId === siblingId)).toEqual(
			sibling,
		);

		const { transcribeVideo } = await import("@/lib/transcribe");
		await transcribeVideo(videoId as never, ownerId);
		expect(mocks.start).toHaveBeenCalledTimes(1);
	});

	it("keeps an active recovery claim and still hands off once", async () => {
		const upload = store.uploads.find((row) => row.videoId === videoId);
		Object.assign(upload ?? {}, {
			phase: "error",
			processingError: "worker failed",
			processingProgress: 0,
			recoveryClaimId: "claim-1",
			recoveryLeaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
		});

		await expect(
			processVideoWorkflow({
				videoId,
				userId: ownerId,
				rawFileKey,
				bucketId: null,
				recoveryClaimId: "claim-1",
			}),
		).resolves.toMatchObject({ success: true });

		expect(mocks.remove).toHaveBeenCalledWith(rawFileKey);
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(
			store.uploads.find((row) => row.videoId === videoId),
		).toBeUndefined();
	});

	it("does not clear an active recovery lease when the callback arrives first", async () => {
		const lease = new Date("2099-01-01T00:00:00.000Z");
		const upload = store.uploads.find((row) => row.videoId === videoId);
		Object.assign(upload ?? {}, {
			processingProgress: 40,
			recoveryClaimId: "claim-1",
			recoveryLeaseExpiresAt: lease,
		});

		const response = await postComplete();

		expect(response.status).toBe(200);
		expect(upload).toMatchObject({
			phase: "processing",
			processingError: null,
			processingProgress: 100,
			rawFileKey,
			recoveryClaimId: "claim-1",
			recoveryLeaseExpiresAt: lease,
		});
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("enqueues source preparation once for a flagged owner and ignores the retry", async () => {
		process.env.CAP_INSTANT_FINISH_OWNERS = ownerId;

		await postComplete();
		await postComplete();

		expect(store.outbox).toHaveLength(1);
		expect(store.outbox[0]).toMatchObject({
			job: "source-prepare",
			videoId,
		});
		expect(mocks.start).not.toHaveBeenCalled();
		expect(store.uploads.find((row) => row.videoId === videoId)).toMatchObject({
			phase: "processing",
			processingProgress: 100,
			rawFileKey,
		});
	});

	it("does not invent completion for a missing upload or a replaced raw key", async () => {
		store.uploads = store.uploads.filter((row) => row.videoId !== videoId);
		await postComplete();
		expect(
			store.uploads.find((row) => row.videoId === videoId),
		).toBeUndefined();
		expect(store.videos.find((row) => row.id === videoId)?.width).toBeNull();
		expect(mocks.start).not.toHaveBeenCalled();

		store.uploads = [uploadRow(videoId, rawFileKey)];
		store.beforeUploadUpdate = () => {
			const upload = store.uploads.find((row) => row.videoId === videoId);
			if (upload) upload.rawFileKey = `${ownerId}/${videoId}/replacement.mp4`;
			store.beforeUploadUpdate = undefined;
		};
		await postComplete();
		expect(store.uploads[0]).toMatchObject({
			processingProgress: 10,
			rawFileKey: `${ownerId}/${videoId}/replacement.mp4`,
		});
		expect(store.videos.find((row) => row.id === videoId)?.width).toBeNull();
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("does not clean up or transcribe a workflow with the wrong raw key", async () => {
		await postComplete();

		await expect(
			processVideoWorkflow({
				videoId,
				userId: ownerId,
				rawFileKey: `${ownerId}/${videoId}/other.mp4`,
				bucketId: null,
			}),
		).rejects.toThrow("Upload raw file key does not match");

		expect(mocks.remove).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
		expect(
			store.uploads.find((row) => row.videoId === videoId)?.rawFileKey,
		).toBe(rawFileKey);
	});
});

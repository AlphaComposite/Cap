import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getOwnedById: vi.fn(),
	storage: vi.fn(),
	sign: vi.fn(),
	database: vi.fn(),
	prepareReplacement: vi.fn(),
	invalidate: vi.fn(),
	head: vi.fn(),
	queueTranscription: vi.fn(),
	shouldQueueTranscription: vi.fn(),
	complete: vi.fn(),
	create: vi.fn(),
	abort: vi.fn(),
	mediaUrl: "http://media.test:3456",
	webhookBase: undefined as string | undefined,
	enqueue: vi.fn(async () => ({ enqueued: false })),
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		NEXTAUTH_SECRET: "test-reupload-secret",
		MEDIA_SERVER_URL: mocks.mediaUrl,
		WEB_URL: "https://web.test",
		MEDIA_SERVER_WEBHOOK_URL: mocks.webhookBase,
		MEDIA_SERVER_WEBHOOK_SECRET: "test-callback-secret",
	}),
	buildEnv: { NEXT_PUBLIC_IS_CAP: true },
}));
vi.mock("@/lib/desktop-reupload", () => ({
	prepareDesktopReupload: mocks.prepareReplacement,
	invalidateReuploadedVideo: mocks.invalidate,
}));
vi.mock("@cap/web-backend", async () => {
	const { Context, Layer } = await import("effect");
	return {
		Database: Context.GenericTag("test/Database"),
		VideosPolicy: Context.GenericTag("test/VideosPolicy"),
		Storage: { getAccessForVideo: mocks.storage },
		makeCurrentUserLayer: () => Layer.empty,
		provideOptionalAuth: (effect: unknown) => effect,
	};
});
vi.mock("@/app/api/utils", () => ({
	withAuth: async (
		c: { set: (key: string, value: unknown) => void },
		next: () => Promise<void>,
	) => {
		c.set("user", { id: "owner" });
		await next();
	},
}));
vi.mock("@/lib/server", async () => {
	const { Effect, Context, Layer } = await import("effect");
	return {
		runPromise: (effect: Effect.Effect<unknown, unknown, unknown>) =>
			Effect.runPromise(
				effect.pipe(
					Effect.provide(
						Layer.succeed(Context.GenericTag("test/VideosPolicy"), {
							getOwnedById: mocks.getOwnedById,
						}),
					),
					Effect.provide(
						Layer.succeed(Context.GenericTag("test/Database"), {
							use: (callback: (client: unknown) => Promise<unknown>) =>
								Effect.tryPromise(() => callback(mocks.database())),
						}),
					),
				) as Effect.Effect<unknown>,
			),
	};
});
vi.mock("@/lib/google-drive-storage-quota", () => ({
	invalidateGoogleDriveStorageQuotaCache: vi.fn(async () => {}),
}));
vi.mock("@/lib/queue-video-transcription", () => ({
	queueVideoTranscription: mocks.queueTranscription,
	shouldQueueTranscriptionAfterMultipartComplete:
		mocks.shouldQueueTranscription,
}));
vi.mock("@/lib/video-processing", () => ({
	startVideoProcessingWorkflow: vi.fn(),
}));

vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("@/lib/source-prepare", () => ({
	enqueueVerifiedReady: mocks.enqueue,
}));

import { app } from "@/app/api/upload/[...route]/multipart";

describe("multipart remux completion callback", () => {
	afterEach(() => vi.unstubAllGlobals());
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.webhookBase = undefined;
		mocks.getOwnedById.mockReturnValue(
			Effect.succeed(
				Option.some([
					{
						id: "video",
						ownerId: "owner",
						source: { type: "webMP4" },
						storageIntegrationId: Option.none(),
					},
				]),
			),
		);
		mocks.database.mockReturnValue({
			transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
				callback({
					update: () => ({ set: () => ({ where: async () => {} }) }),
					delete: () => ({ where: async () => {} }),
				}),
		});
		mocks.storage.mockReturnValue(
			Effect.succeed([
				{
					provider: "s3",
					bucketName: "test-bucket",
					multipart: {
						complete: () =>
							Effect.succeed({
								ETag: "uploaded",
								Location: "https://storage.test/result.mp4",
							}),
					},
					headObject: () =>
						Effect.succeed({
							ETag: "uploaded",
							ContentLength: 1024,
							ContentType: "video/mp4",
						}),
					copyObject: () =>
						Effect.succeed({ CopyObjectResult: { ETag: "final" } }),
					getInternalSignedObjectUrl: () =>
						Effect.succeed("http://storage.test/input"),
					getInternalPresignedPutUrl: () =>
						Effect.succeed("http://storage.test/output"),
				},
			]),
		);
		mocks.shouldQueueTranscription.mockReturnValue(false);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ jobId: "test-job" }), { status: 200 }),
			),
		);
	});

	it.each([
		[undefined, "https://web.test/api/webhooks/media-server/progress"],
		[
			"http://internal-web:3000",
			"http://internal-web:3000/api/webhooks/media-server/progress",
		],
	])(
		"sends an authenticated ready callback using base %s",
		async (base, expectedUrl) => {
			mocks.webhookBase = base;
			const response = await app.request("/complete", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					videoId: "video",
					subpath: "result.mp4",
					uploadId: "upload",
					parts: [{ partNumber: 1, etag: "part", size: 1024 }],
					durationInSecs: 60,
				}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ success: true });
			expect(mocks.enqueue).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					hook: "multipart-final",
					remuxPending: true,
				}),
			);
			const call = vi.mocked(fetch).mock.calls[0];
			if (!call) throw new Error("Expected a remux dispatch");
			expect(call[0]).toBe("http://media.test:3456/video/process");
			const dispatched = JSON.parse(String(call[1]?.body));
			expect(dispatched).toMatchObject({
				videoId: "video",
				userId: "owner",
				remuxOnly: true,
				webhookUrl: expectedUrl,
				webhookSecret: "test-callback-secret",
			});
			expect(call[1]?.headers).toMatchObject({
				"x-media-server-secret": "test-callback-secret",
			});
		},
	);
});

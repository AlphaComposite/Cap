import { User, Video } from "@cap/web-domain";
import { Effect } from "effect";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	head: vi.fn(),
	read: vi.fn(),
	download: vi.fn(),
	signed: vi.fn(),
	flagged: false,
	provider: "s3",
	userId: "viewer",
	token: null as { videoId: string; key: string } | null,
	video: {
		id: "video",
		ownerId: "owner",
		metadata: { _tag: "None" },
		source: { type: "desktopMP4" },
	},
}));

vi.mock("@cap/web-backend", async () => {
	const { Effect, Option } = await import("effect");
	return {
		provideOptionalAuth: (effect: unknown) => effect,
		Storage: {
			getAccessForVideo: () =>
				Effect.succeed([
					{
						provider: mocks.provider,
						headObject: mocks.head,
						getObjectResponse: mocks.read,
						getInternalDownload: mocks.download,
						getSignedObjectUrl: mocks.signed,
					},
				]),
		},
		Videos: Effect.succeed({
			getByIdForViewing: () => Effect.succeed(Option.some([mocks.video])),
		}),
		VideosRepo: Effect.succeed({
			getById: () => Effect.succeed(Option.some([mocks.video])),
		}),
		verifyStorageObjectToken: () => mocks.token,
	};
});
vi.mock("@cap/database", () => ({
	db: () => ({ select: () => ({ from: () => ({ where: async () => [] }) }) }),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: mocks.userId }),
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ MEDIA_SERVER_WEBHOOK_SECRET: "test-media-secret" }),
}));
vi.mock("@/lib/instant-finish-flag", () => ({
	isInstantFinishEnabledForOwner: () => mocks.flagged,
}));
vi.mock("@/lib/server", async () => ({
	runPromise: (await import("effect")).Effect.runPromise,
}));
vi.mock("@/utils/helpers", () => ({ CACHE_CONTROL_HEADERS: {} }));

import { GET, HEAD } from "@/app/api/storage/object/route";
import { canUserDownloadVideo } from "@/lib/video-download-permissions";

function request(
	key: string,
	method = "GET",
	headers: Record<string, string> = {},
) {
	return (method === "HEAD" ? HEAD : GET)(
		new NextRequest(
			`https://cap.test/api/storage/object?videoId=video&key=${encodeURIComponent(key)}${mocks.token ? "&token=test" : ""}`,
			{
				method: method === "HEAD" ? "HEAD" : "GET",
				headers: {
					...(method === "RANGE" ? { Range: "bytes=0-3" } : {}),
					...headers,
				},
			},
		),
	);
}

function expectNoStorageRead() {
	expect(mocks.head).not.toHaveBeenCalled();
	expect(mocks.read).not.toHaveBeenCalled();
	expect(mocks.signed).not.toHaveBeenCalled();
	expect(mocks.download).not.toHaveBeenCalled();
}

describe("generic object proxy edited-export denial", () => {
	beforeEach(() => {
		mocks.token = null;
		mocks.flagged = false;
		mocks.provider = "s3";
		mocks.userId = "viewer";
		mocks.head.mockReturnValue(Effect.succeed({ ContentLength: 4 }));
		mocks.read.mockImplementation(() =>
			Effect.succeed(new Response("data", { status: 206 })),
		);
		mocks.signed.mockReturnValue(Effect.succeed("https://example.test/signed"));
		mocks.download.mockReturnValue(
			Effect.succeed({ version: 1, url: "https://example.test/media" }),
		);
	});

	it.each(
		["current/7/attempt.mp4", "superseded/6/retired.mp4"].flatMap((suffix) =>
			["GET", "HEAD", "RANGE"].flatMap((method) =>
				[false, true].flatMap((token) =>
					[false, true].flatMap((flagged) =>
						["s3", "googleDrive"].map((provider) => ({
							suffix,
							method,
							token,
							flagged,
							provider,
						})),
					),
				),
			),
		),
	)(
		"denies viewable non-downloader $suffix $method token=$token flagged=$flagged $provider",
		async ({ suffix, method, token, flagged, provider }) => {
			mocks.flagged = flagged;
			mocks.provider = provider;
			const key = `owner/video/private/edited/${suffix}`;
			mocks.token = token ? { videoId: "video", key } : null;
			expect(
				await canUserDownloadVideo({
					userId: User.UserId.make("viewer"),
					ownerId: User.UserId.make("owner"),
					videoId: Video.VideoId.make("video"),
				}),
			).toBe(false);
			expect((await request(key, method)).status).toBe(404);
			expectNoStorageRead();
		},
	);

	it("does not let an owner with an exact object token bypass the denial", async () => {
		mocks.userId = "owner";
		const key = "owner/video/private/edited/current/7/attempt.mp4";
		mocks.token = { videoId: "video", key };
		expect((await request(key)).status).toBe(404);
		expectNoStorageRead();
	});

	it.each([
		"owner/video/private/edited/current/7/attempt.mp4",
		"owner/video/source/original.mp4",
		"owner/video/.recording/sources/generation/snapshot/video/0.mp4",
	])(
		"preserves authenticated internal descriptors, not forged internal headers: %s",
		async (key) => {
			mocks.flagged = true;
			mocks.token = { videoId: "video", key };
			expect(
				(
					await request(key, "GET", {
						"x-cap-internal-download": "1",
						"x-media-server-secret": "invalid",
					})
				).status,
			).toBe(401);
			expectNoStorageRead();
			expect(
				(
					await request(key, "GET", {
						"x-cap-internal-download": "1",
						"x-media-server-secret": "test-media-secret",
					})
				).status,
			).toBe(200);
			expect(mocks.download).toHaveBeenCalledWith(
				key,
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
		},
	);

	it.each([
		"owner/video/private/edited-copy/file.mp4",
		"owner/video/comments/comment/media.mp4",
	])(
		"does not broaden denial beyond edited-export namespace: %s",
		async (key) => {
			expect((await request(key)).status).toBe(302);
			expect(mocks.signed).toHaveBeenCalledWith(key);
		},
	);
});

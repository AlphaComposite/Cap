import { Video } from "@cap/web-domain";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	userId: "owner",
	canDownload: vi.fn(),
	getAccess: vi.fn(),
	getSignedUrl: vi.fn(),
	headObject: vi.fn(),
}));

vi.mock("@cap/database/schema", () => ({
	videos: { name: "videos", id: "id" },
	videoEdits: {
		name: "videoEdits",
		videoId: "videoId",
		sourceKey: "sourceKey",
	},
	videoUploads: { name: "videoUploads", videoId: "videoId", phase: "phase" },
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: { name: string }) => ({
				where: async () => {
					if (table.name === "videos") {
						return [
							{
								id: "video",
								ownerId: "owner",
								name: "Example",
								source: { type: "webMP4" },
								bucket: null,
								storageIntegrationId: null,
							},
						];
					}
					if (table.name === "videoEdits") {
						return [{ sourceKey: "owner/video/source/original.mp4" }];
					}
					return [];
				},
			}),
		}),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: mocks.userId }),
}));
vi.mock("@/lib/video-download-permissions", () => ({
	canUserDownloadVideo: mocks.canDownload,
}));
vi.mock("@cap/web-backend", () => ({
	Storage: { getAccessForVideo: mocks.getAccess },
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (value: unknown) => value,
}));
vi.mock("@/lib/server", async () => ({
	runPromise: (await import("effect")).Effect.runPromise,
}));

import { getVideoDownloadInfo } from "@/actions/videos/download";

const videoId = Video.VideoId.make("video");

describe("video download variants", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.userId = "owner";
		mocks.canDownload.mockResolvedValue(true);
		mocks.headObject.mockReturnValue(Effect.succeed({}));
		mocks.getSignedUrl.mockReturnValue(
			Effect.succeed("https://storage.test/original.mp4"),
		);
		mocks.getAccess.mockReturnValue(
			Effect.succeed([
				{
					headObject: mocks.headObject,
					getSignedObjectUrl: mocks.getSignedUrl,
				},
			]),
		);
	});

	it("rejects original-source downloads for non-owners even when sharing permits current downloads", async () => {
		mocks.userId = "collaborator";

		await expect(getVideoDownloadInfo(videoId, "original")).rejects.toThrow(
			"You don't have permission to download this video",
		);
		expect(mocks.canDownload).not.toHaveBeenCalled();
		expect(mocks.getAccess).not.toHaveBeenCalled();
	});

	it("allows the owner to download the immutable original", async () => {
		await expect(getVideoDownloadInfo(videoId, "original")).resolves.toEqual({
			success: true,
			downloadUrl: "https://storage.test/original.mp4",
			filename: "Example (original).mp4",
		});
		expect(mocks.getSignedUrl).toHaveBeenCalledWith(
			"owner/video/source/original.mp4",
		);
	});
});

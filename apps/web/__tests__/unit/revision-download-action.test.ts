import { Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DOWNLOAD_MAX_FAILURES,
	DOWNLOAD_MAX_POLLS,
	planDownloadAttempt,
} from "@/lib/revision-download-job";

const mocks = vi.hoisted(() => ({
	userId: "owner",
	canDownload: vi.fn(),
	artifactUrl: vi.fn(async () => null as string | null),
	eligible: vi.fn(async () => false),
	flagged: vi.fn(() => true),
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
								name: "Edited clip",
								source: { type: "webMP4" },
								bucket: null,
								storageIntegrationId: null,
							},
						];
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
	Storage: { getAccessForVideo: vi.fn() },
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (value: unknown) => value,
}));
vi.mock("@/lib/server", async () => ({
	runPromise: (await import("effect")).Effect.runPromise,
}));
vi.mock("@/lib/instant-finish-flag", () => ({
	isInstantFinishEnabledForOwner: mocks.flagged,
}));
vi.mock("@/lib/flagged-unedited", () => ({
	loadEligibleLegacy: mocks.eligible,
	isViewerPrivateKey: () => false,
}));
vi.mock("@/lib/revision-media-grant", () => ({
	revisionArtifactUrl: mocks.artifactUrl,
	ownerOriginalPath: (id: string) => `/api/media/original?videoId=${id}`,
}));

import { getVideoDownloadInfo } from "@/actions/videos/download";

const videoId = Video.VideoId.make("video");

describe("revision download action", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.userId = "owner";
		mocks.canDownload.mockResolvedValue(true);
		mocks.eligible.mockResolvedValue(false);
		mocks.flagged.mockReturnValue(true);
		mocks.artifactUrl.mockResolvedValue(null);
	});

	it("returns a neutral not-ready result, then the edited MP4 once READY", async () => {
		await expect(getVideoDownloadInfo(videoId, "current")).resolves.toEqual({
			success: false,
			pending: true,
			message: "Preparing your download. Try again in a minute.",
		});

		mocks.artifactUrl.mockResolvedValue(
			"https://origin.test/media/video/r/rev/download.mp4?t=grant",
		);
		await expect(getVideoDownloadInfo(videoId, "current")).resolves.toEqual({
			success: true,
			downloadUrl: "https://origin.test/media/video/r/rev/download.mp4?t=grant",
			filename: "Edited clip.mp4",
		});
	});

	it("leaves Download original on the owner proxy", async () => {
		await expect(getVideoDownloadInfo(videoId, "original")).resolves.toEqual({
			success: true,
			downloadUrl: "/api/media/original?videoId=video",
			filename: "Edited clip (original).mp4",
		});
		expect(mocks.artifactUrl).not.toHaveBeenCalled();
	});
});

describe("revision download job plan", () => {
	it("retries a building origin without counting a failure, then yields", () => {
		const building = planDownloadAttempt({
			current: false,
			originStatus: 202,
			failures: 0,
			polls: 0,
			nowMs: 1_000,
		});
		expect(building).toEqual({ action: "skip" });

		const again = planDownloadAttempt({
			current: true,
			originStatus: 202,
			failures: 0,
			polls: 0,
			nowMs: 1_000,
		});
		expect(again.action).toBe("retry");
		if (again.action !== "retry") throw new Error("expected retry");
		expect(again.failures).toBe(0);
		expect(again.polls).toBe(1);
		expect(again.notBeforeMs).toBeGreaterThan(1_000);

		expect(
			planDownloadAttempt({
				current: true,
				originStatus: 200,
				failures: 3,
				polls: 4,
				nowMs: 1_000,
			}),
		).toEqual({ action: "ready" });

		expect(
			planDownloadAttempt({
				current: true,
				originStatus: 500,
				failures: DOWNLOAD_MAX_FAILURES,
				polls: 1,
				nowMs: 1_000,
			}).action,
		).toBe("exhausted");
		expect(
			planDownloadAttempt({
				current: true,
				originStatus: 202,
				failures: 0,
				polls: DOWNLOAD_MAX_POLLS,
				nowMs: 1_000,
			}).action,
		).toBe("yield");
	});
});

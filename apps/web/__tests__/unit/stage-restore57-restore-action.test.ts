import { Video } from "@cap/web-domain";
import { afterEach, describe, expect, it, vi } from "vitest";

const retained = vi.hoisted(() =>
	vi.fn(async () => ({ revisionId: "must-not-run", generation: 9 })),
);
const writes = vi.hoisted(() => [] as string[]);

vi.mock("server-only", () => ({}));
vi.mock("@/lib/revision-publication", () => ({
	restoreRetainedIdentity: retained,
}));
vi.mock("@cap/database/schema", () => ({
	videos: { name: "video", id: "id" },
	videoUploads: { name: "upload", videoId: "videoId" },
	videoEdits: { name: "edit", videoId: "videoId" },
	sourceObject: {
		name: "source_object",
		liveKey: { name: "live_key" },
		videoId: { name: "video_id" },
	},
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: { name: string }) => ({
				where: () => {
					if (table.name === "video") {
						return Promise.resolve([
							{
								id: "video",
								ownerId: "owner",
								source: { type: "webMP4" },
								duration: 20,
								metadata: null,
								isScreenshot: false,
							},
						]);
					}
					return Promise.resolve([]);
				},
			}),
		}),
		insert: () => ({
			values: async () => {
				writes.push("insert");
			},
		}),
		update: () => ({
			set: () => ({
				where: async () => {
					writes.push("update");
				},
			}),
		}),
		delete: () => ({
			where: async () => {
				writes.push("delete");
			},
		}),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "owner", isPro: true }),
}));
vi.mock("@cap/utils", () => ({
	userIsPro: (user: { isPro: boolean }) => user.isPro,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ MEDIA_SERVER_URL: "https://media.test" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/server", () => ({ runPromise: (value: unknown) => value }));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/utils/flags", () => ({ isAiGenerationEnabled: async () => false }));

import { restoreVideoToOriginal } from "@/actions/videos/save-edits";

const videoId = Video.VideoId.make("video");

describe("flagged legacy restore action", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		retained.mockClear();
		writes.length = 0;
	});

	it("refuses before retained restore and writes nothing", async () => {
		vi.stubEnv("CAP_INSTANT_FINISH_OWNERS", "owner");
		await expect(restoreVideoToOriginal(videoId)).rejects.toThrow(
			/Done|local|refused/i,
		);
		expect(retained).not.toHaveBeenCalled();
		expect(writes).toEqual([]);
	});

	it("keeps the unflagged skip when no legacy edit exists", async () => {
		vi.stubEnv("CAP_INSTANT_FINISH_OWNERS", "");
		await expect(restoreVideoToOriginal(videoId)).resolves.toEqual({
			success: true,
			skipped: true,
		});
		expect(retained).not.toHaveBeenCalled();
	});
});

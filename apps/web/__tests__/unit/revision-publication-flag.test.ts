import { beforeEach, describe, expect, it, vi } from "vitest";

const where = vi.fn();
const start = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "owner-a", isPro: true }),
}));
vi.mock("@cap/utils", () => ({
	userIsPro: () => true,
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where,
			}),
		}),
		insert: () => ({ values: async () => undefined }),
	}),
}));
vi.mock("@cap/web-backend", () => ({
	Storage: { getAccessForVideo: vi.fn() },
}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("workflow/api", () => ({ start }));
vi.mock("@/workflows/edit-video", () => ({
	editVideoWorkflow: Object.assign(vi.fn(), { workflowId: "edit" }),
}));

const video = {
	id: "video-1",
	ownerId: "owner-a",
	isScreenshot: false,
	source: { type: "webMP4" },
	bucket: null,
	storageIntegrationId: null,
	metadata: null,
	duration: 10,
};

describe("server owner flag", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.unstubAllEnvs();
		where.mockReset();
		where.mockResolvedValueOnce([video]).mockResolvedValueOnce([]);
	});

	it("denies a crafted publish call when the owner is not allowlisted", async () => {
		vi.stubEnv("CAP_INSTANT_FINISH_OWNERS", "someone-else");
		const { publishVideoRevision } = await import(
			"@/actions/videos/publish-revision"
		);
		await expect(
			publishVideoRevision({
				videoId: "video-1" as never,
				editSpec: {
					version: 2,
					sourceDuration: 10,
					keepRanges: [{ start: 0, end: 1 }],
					manualKeepRanges: [{ start: 0, end: 1 }],
					autoCuts: {
						silence: {
							enabled: false,
							ranges: [],
							thresholdMs: 0,
							padMs: 0,
							removedMs: 0,
							gapCount: 0,
						},
						fillers: {
							enabled: false,
							ranges: [],
							mode: "ums",
							padMs: 0,
							removedCount: 0,
							skippedCount: 0,
						},
					},
				},
				baseGeneration: 0,
				draftVersion: 1,
				draftSession: "session",
			}),
		).rejects.toThrow("Instant finish is not enabled");
	});

	it("denies a crafted saveVideoEdits call when the owner is allowlisted", async () => {
		vi.stubEnv("CAP_INSTANT_FINISH_OWNERS", "owner-a");
		const { saveVideoEdits } = await import("@/actions/videos/save-edits");
		await expect(
			saveVideoEdits("video-1" as never, {
				version: 1,
				sourceDuration: 10,
				keepRanges: [{ start: 0, end: 5 }],
			}),
		).rejects.toThrow("Publish the revision instead of starting a render");
		expect(start).not.toHaveBeenCalled();
	});
});

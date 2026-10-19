import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queue: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: async () => [
					{
						id: "video",
						ownerId: "owner",
						source: { type: "webMP4" },
						bucket: null,
						storageIntegrationId: null,
					},
				],
			}),
		}),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "owner" }),
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/instant-finish-flag", () => ({
	isInstantFinishEnabledForOwner: () => true,
}));
vi.mock("@/lib/revision-publication", () => ({
	RevisionPublicationError: class extends Error {},
	recordServerDraft: async () => ({
		generation: 1,
		draftVersion: 1,
		draftSession: "owner",
	}),
	publishInstantFinishRevision: async () => ({
		revisionId: "revision",
		success: true,
	}),
}));
vi.mock("@/lib/revision-publication-origin", () => ({
	httpOriginClient: () => ({}),
}));
vi.mock("@/lib/revision-publication-read", () => ({
	getInstantFinishPublicationDto: async () => ({ currentRevisionId: null }),
}));
vi.mock("@/lib/revision-media-grant", () => ({
	mintRevisionMediaGrant: vi.fn(),
}));
vi.mock("@/lib/share-web-url", () => ({
	resolveShareWebUrl: async () => "http://localhost:3000",
}));

beforeEach(() => {
	vi.resetModules();
	vi.doMock("@/lib/generate-ai", () => ({
		startRevisionChapterGeneration: mocks.queue,
	}));
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

it.each([
	"hang",
	"sync throw",
	"async throw",
	"import throw",
	"async import throw",
])("Done returns independently of queue: %s", async (mode) => {
	if (mode === "hang")
		mocks.queue.mockImplementation(() => new Promise(() => {}));
	if (mode === "sync throw")
		mocks.queue.mockImplementation(() => {
			throw new Error("queue sync");
		});
	if (mode === "async throw")
		mocks.queue.mockRejectedValue(new Error("queue async"));
	if (mode === "import throw")
		vi.doMock("@/lib/generate-ai", () => {
			throw new Error("import sync");
		});
	if (mode === "async import throw")
		vi.doMock("@/lib/generate-ai", async () => {
			throw new Error("import async");
		});
	const { publishOwnerRevision } = await import("@/lib/revision-publish");
	const done = publishOwnerRevision(
		{
			videoId: "video" as never,
			editSpec: { sourceDuration: 100 } as never,
			baseGeneration: 0,
			draftVersion: 1,
			draftSession: "owner",
		},
		new Headers(),
	);
	// Attach rejection handling immediately; a hung queue must not hold Done.
	const result = await Promise.race([
		done.then(
			(value) => value,
			() => "rejected",
		),
		new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
	]);
	expect(result).toMatchObject({ success: true, revisionId: "revision" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	if (mode !== "hang") expect(console.warn).toHaveBeenCalled();
});

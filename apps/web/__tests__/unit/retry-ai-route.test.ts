import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	getCurrentUser: vi.fn(),
	isAiGenerationEnabled: vi.fn(),
	revalidatePath: vi.fn(),
	startAiGeneration: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@cap/database/schema", () => ({
	users: {
		id: "users.id",
		email: "users.email",
		stripeSubscriptionStatus: "users.stripeSubscriptionStatus",
		thirdPartyStripeSubscriptionId: "users.thirdPartyStripeSubscriptionId",
	},
	videos: {
		id: "videos.id",
	},
}));
vi.mock("drizzle-orm", () => ({
	eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
}));
vi.mock("next/cache", () => ({
	revalidatePath: mocks.revalidatePath,
}));
vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: mocks.startAiGeneration,
}));
vi.mock("@/utils/flags", () => ({
	isAiGenerationEnabled: mocks.isAiGenerationEnabled,
}));

function makeSelectChain<T>(rows: T[]) {
	const chain = {
		select: vi.fn(),
		from: vi.fn(),
		where: vi.fn(),
		limit: vi.fn(),
	};
	chain.select.mockReturnValue(chain);
	chain.from.mockReturnValue(chain);
	chain.where.mockReturnValue(chain);
	chain.limit.mockResolvedValue(rows);
	return chain;
}

const baseVideo = {
	id: "video-1",
	ownerId: "owner-1",
	transcriptionStatus: "COMPLETE",
	duration: 120,
	metadata: {
		summary: "Pasted owner summary",
		summaryManuallyEdited: true,
		aiGenerationStatus: "COMPLETE",
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getCurrentUser.mockResolvedValue({ id: "owner-1" });
	mocks.isAiGenerationEnabled.mockResolvedValue(true);
	mocks.startAiGeneration.mockResolvedValue({
		success: true,
		message: "AI generation workflow started",
	});
});

describe("retry AI route", () => {
	it("retries a complete record when chapters are missing without touching the pasted summary", async () => {
		mocks.db
			.mockReturnValueOnce(makeSelectChain([baseVideo]))
			.mockReturnValueOnce(
				makeSelectChain([
					{
						email: "owner@example.com",
						stripeSubscriptionStatus: "active",
						thirdPartyStripeSubscriptionId: null,
					},
				]),
			);

		const { POST } = await import("@/app/api/videos/[videoId]/retry-ai/route");
		const response = await POST(new Request("http://localhost"), {
			params: Promise.resolve({ videoId: "video-1" }),
		} as never);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ success: true });
		expect(mocks.startAiGeneration).toHaveBeenCalledWith("video-1", "owner-1");
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/s/video-1");
	});

	it("retries a completed record with an automatic empty chapter array", async () => {
		mocks.db
			.mockReturnValueOnce(
				makeSelectChain([
					{
						...baseVideo,
						metadata: {
							...baseVideo.metadata,
							chapters: [],
						},
					},
				]),
			)
			.mockReturnValueOnce(
				makeSelectChain([
					{
						email: "owner@example.com",
						stripeSubscriptionStatus: "active",
						thirdPartyStripeSubscriptionId: null,
					},
				]),
			);

		const { POST } = await import("@/app/api/videos/[videoId]/retry-ai/route");
		const response = await POST(new Request("http://localhost"), {
			params: Promise.resolve({ videoId: "video-1" }),
		} as never);

		expect(response.status).toBe(200);
		expect(mocks.startAiGeneration).toHaveBeenCalledOnce();
	});

	it("does not retry a completed record with an explicitly manual empty state", async () => {
		mocks.db.mockReturnValueOnce(
			makeSelectChain([
				{
					...baseVideo,
					metadata: {
						...baseVideo.metadata,
						chapters: [],
						chaptersManuallyEdited: true,
					},
				},
			]),
		);

		const { POST } = await import("@/app/api/videos/[videoId]/retry-ai/route");
		const response = await POST(new Request("http://localhost"), {
			params: Promise.resolve({ videoId: "video-1" }),
		} as never);

		expect(response.status).toBe(400);
		expect(mocks.startAiGeneration).not.toHaveBeenCalled();
	});

	it("does not retry a complete record with valid chapters", async () => {
		mocks.db.mockReturnValueOnce(
			makeSelectChain([
				{
					...baseVideo,
					metadata: {
						...baseVideo.metadata,
						chapters: [{ title: "Opening", start: 0 }],
					},
				},
			]),
		);

		const { POST } = await import("@/app/api/videos/[videoId]/retry-ai/route");
		const response = await POST(new Request("http://localhost"), {
			params: Promise.resolve({ videoId: "video-1" }),
		} as never);

		expect(response.status).toBe(400);
		expect(mocks.startAiGeneration).not.toHaveBeenCalled();
	});

	it("retries malformed chapter state instead of treating an array as completion", async () => {
		mocks.db
			.mockReturnValueOnce(
				makeSelectChain([
					{
						...baseVideo,
						metadata: {
							...baseVideo.metadata,
							chapters: [{ title: "", start: 0 }],
						},
					},
				]),
			)
			.mockReturnValueOnce(
				makeSelectChain([
					{
						email: "owner@example.com",
						stripeSubscriptionStatus: "active",
						thirdPartyStripeSubscriptionId: null,
					},
				]),
			);

		const { POST } = await import("@/app/api/videos/[videoId]/retry-ai/route");
		const response = await POST(new Request("http://localhost"), {
			params: Promise.resolve({ videoId: "video-1" }),
		} as never);

		expect(response.status).toBe(200);
		expect(mocks.startAiGeneration).toHaveBeenCalledOnce();
	});
});

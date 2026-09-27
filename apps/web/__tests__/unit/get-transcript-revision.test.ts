import { Exit } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	getCurrentUser: vi.fn(),
	runPromise: vi.fn(),
	runPromiseExit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: (effect: unknown) => effect,
	Storage: { getAccessForVideo: vi.fn() },
	VideosPolicy: {},
}));
vi.mock("@/lib/server", () => ({
	runPromise: mocks.runPromise,
	runPromiseExit: mocks.runPromiseExit,
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (value: unknown) => value,
}));

import { getTranscript } from "@/actions/videos/get-transcript";

const kept = "WEBVTT\n\n00:00:00.400 --> 00:00:00.800\nkeptword\n";

function query(result: unknown) {
	const chain = {
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		limit: async () => result,
	};
	return { select: () => chain };
}

describe("flagged getTranscript", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.CAP_INSTANT_FINISH_OWNERS = "flagged-owner";
		mocks.getCurrentUser.mockResolvedValue({ id: "flagged-owner" });
		mocks.runPromiseExit.mockResolvedValue(
			Exit.succeed([
				{
					video: {
						id: "video-1",
						ownerId: "flagged-owner",
						transcriptionStatus: "COMPLETE",
					},
				},
			]),
		);
		mocks.db.mockReturnValue(
			query([
				{
					snapshot: { captionsVtt: kept },
				},
			]),
		);
		mocks.runPromise.mockImplementation(() => {
			throw new Error("transcription.vtt must not be read");
		});
	});

	it("returns the current revision captions and not the refusal", async () => {
		const result = await getTranscript("video-1" as never);
		expect(result.success).toBe(true);
		expect(result.content).toContain("keptword");
		expect(result.message).not.toBe(
			"Transcript is not available for this revision",
		);
		expect(mocks.runPromise).not.toHaveBeenCalled();
	});
});

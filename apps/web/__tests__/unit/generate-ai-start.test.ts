import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.fn();
const mockStart = vi.fn();
const randomUUIDMock = vi.hoisted(() => vi.fn(() => "generation-1"));
const serverEnvMock = vi.hoisted(() =>
	vi.fn<() => Record<string, string | undefined>>(() => ({
		GROQ_API_KEY: "test-key",
	})),
);

vi.mock("@cap/database", () => ({
	db: mockDb,
}));

vi.mock("@cap/database/schema", () => ({
	videos: {
		id: "videos.id",
		metadata: "videos.metadata",
		transcriptionStatus: "videos.transcriptionStatus",
		updatedAt: "videos.updatedAt",
	},
}));

vi.mock("@cap/env", () => ({
	serverEnv: serverEnvMock,
}));

vi.mock("node:crypto", () => ({
	randomUUID: randomUUIDMock,
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...conditions: unknown[]) => conditions),
	eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
	sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings,
		values,
	})),
}));

vi.mock("workflow/api", () => ({
	start: mockStart,
}));

vi.mock("@/workflows/generate-ai", () => ({
	generateAiWorkflow: vi.fn(),
}));

function makeSelectChain(video: unknown) {
	const chain = {
		select: vi.fn(),
		from: vi.fn(),
		where: vi.fn(),
	};
	chain.select.mockReturnValue(chain);
	chain.from.mockReturnValue(chain);
	chain.where.mockResolvedValue([{ video }]);
	return chain;
}

function makeUpdateChain(affectedRows: number) {
	const chain = {
		update: vi.fn(),
		set: vi.fn(),
		where: vi.fn(),
	};
	chain.update.mockReturnValue(chain);
	chain.set.mockReturnValue(chain);
	chain.where.mockResolvedValue([{ affectedRows }]);
	return chain;
}

function makeSameSecondStaleClaimUpdateChain() {
	const chain = makeUpdateChain(1);
	chain.where.mockImplementation(async (condition: unknown) => {
		const serialized = JSON.stringify(condition);
		const comparesObservedGeneration =
			serialized.includes("$.aiGenerationId") && serialized.includes("<=>");
		const comparesObservedState =
			serialized.includes("$.aiGenerationStatus") && serialized.includes("<=>");

		// The row changed from legacy/null metadata to a newer completed
		// generation during the stale reader's same-second claim window. A
		// correctly fenced UPDATE matches zero rows; the old updatedAt/state-only
		// predicate would incorrectly match this row.
		return [
			{
				affectedRows:
					comparesObservedGeneration && comparesObservedState ? 0 : 1,
			},
		];
	});
	return chain;
}

const video = {
	id: "video-1",
	transcriptionStatus: "COMPLETE",
	duration: 120,
	metadata: {},
	updatedAt: new Date("2026-07-20T15:00:00.000Z"),
};

beforeEach(() => {
	vi.clearAllMocks();
	randomUUIDMock.mockReturnValue("generation-1");
	serverEnvMock.mockReturnValue({ GROQ_API_KEY: "test-key" });
	mockStart.mockResolvedValue({ runId: "run-1" });
});

describe("startAiGeneration", () => {
	it("queues without replacing concurrently edited metadata", async () => {
		const update = makeUpdateChain(1);
		mockDb
			.mockReturnValueOnce(makeSelectChain(video))
			.mockReturnValueOnce(update);
		const { startAiGeneration } = await import("@/lib/generate-ai");
		await startAiGeneration("video-1" as never, "user-1");
		const value = update.set.mock.calls[0]?.[0];
		expect(value.metadata.strings.join("")).toContain("JSON_SET(COALESCE(");
		expect(value.metadata.strings.join("")).toContain(
			"'$.aiGenerationStatus', 'QUEUED'",
		);
		expect(value.metadata.values).toEqual(["videos.metadata", "generation-1"]);
	});
	it("fails fast when no AI provider is configured", async () => {
		serverEnvMock.mockReturnValue({});

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1");

		expect(result).toEqual({
			success: false,
			message: "No AI provider configured",
		});
		expect(mockDb).not.toHaveBeenCalled();
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("starts after atomically claiming the current video version", async () => {
		mockDb
			.mockReturnValueOnce(makeSelectChain(video))
			.mockReturnValueOnce(makeUpdateChain(1));

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1");

		expect(result).toEqual({
			success: true,
			message: "AI generation workflow started",
		});
		expect(mockStart).toHaveBeenCalledTimes(1);
		expect(mockStart).toHaveBeenCalledWith(expect.anything(), [
			{ videoId: "video-1", userId: "user-1", generationId: "generation-1" },
		]);
		const update = mockDb.mock.results[1]?.value;
		const value = update?.set.mock.calls[0]?.[0];
		expect(value.metadata.values).toContain("generation-1");
	});

	it("does not start a duplicate after losing the optimistic claim", async () => {
		mockDb
			.mockReturnValueOnce(makeSelectChain(video))
			.mockReturnValueOnce(makeUpdateChain(0));

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1");

		expect(result).toEqual({
			success: true,
			message: "AI generation already in progress",
		});
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("does not start a stale legacy claim after a same-second completed generation replaces it", async () => {
		const staleLegacyVideo = {
			...video,
			metadata: {},
			// The newer COMPLETE row intentionally retains this second-resolution
			// updatedAt value, so the identity/state predicates must do the fencing.
			updatedAt: new Date("2026-07-20T15:00:00.000Z"),
		};
		const update = makeSameSecondStaleClaimUpdateChain();
		mockDb
			.mockReturnValueOnce(makeSelectChain(staleLegacyVideo))
			.mockReturnValueOnce(update);

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1");

		expect(result).toEqual({
			success: true,
			message: "AI generation already in progress",
		});
		expect(mockStart).not.toHaveBeenCalled();
		const claimConditions = JSON.stringify(update.where.mock.calls[0]?.[0]);
		expect(claimConditions).toContain("$.aiGenerationId");
		expect(claimConditions).toContain("$.aiGenerationStatus");
		expect(claimConditions).toContain("<=>");
	});

	it("treats completed chapters as complete without requiring a summary", async () => {
		const completedVideo = {
			...video,
			metadata: {
				aiGenerationStatus: "COMPLETE",
				chapters: [{ title: "Opening", start: 0 }],
			},
		};
		mockDb.mockReturnValueOnce(makeSelectChain(completedVideo));

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1");

		expect(result).toEqual({
			success: true,
			message: "AI metadata already generated",
		});
		expect(mockStart).not.toHaveBeenCalled();
		expect(mockDb).toHaveBeenCalledTimes(1);
	});

	it("skips a coherent long recording with modern generation provenance", async () => {
		const backfillVideo = {
			...video,
			duration: 1972.9,
			metadata: {
				aiGenerationStatus: "COMPLETE",
				aiGenerationId: "old-generation",
				chapters: [{ title: "Only chapter", start: 0 }],
			},
		};
		mockDb.mockReturnValueOnce(makeSelectChain(backfillVideo));

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1", {
			generationId: "old-generation",
			generationStatus: "COMPLETE",
			chaptersJson: JSON.stringify([{ title: "Only chapter", start: 0 }]),
			chaptersManuallyEditedJson: null,
			transcriptionStatus: "COMPLETE",
			updatedAtJson: "2026-07-20T15:00:00.000Z",
		});

		expect(result.message).toBe("AI metadata already generated");
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("atomically marks a known legacy long one-chapter backfill for its generation", async () => {
		const backfillVideo = {
			...video,
			duration: 1972.9,
			metadata: {
				aiGenerationStatus: "COMPLETE",
				chapters: [{ title: "Only chapter", start: 0 }],
			},
		};
		const update = makeUpdateChain(1);
		mockDb
			.mockReturnValueOnce(makeSelectChain(backfillVideo))
			.mockReturnValueOnce(update);

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1", {
			generationId: null,
			generationStatus: "COMPLETE",
			chaptersJson: JSON.stringify([{ title: "Only chapter", start: 0 }]),
			chaptersManuallyEditedJson: null,
			transcriptionStatus: "COMPLETE",
			updatedAtJson: "2026-07-20T15:00:00.000Z",
		});

		expect(result.message).toBe("AI generation workflow started");
		expect(mockStart).toHaveBeenCalledOnce();
		const metadataUpdate = update.set.mock.calls[0]?.[0].metadata;
		expect(metadataUpdate.strings.join("")).toContain(
			"$.aiChapterBackfillGenerationId",
		);
		expect(metadataUpdate.values).toEqual([
			"videos.metadata",
			"generation-1",
			"generation-1",
		]);
	});

	it("skips a backfill claim when the scanned row version is stale", async () => {
		mockDb.mockReturnValueOnce(
			makeSelectChain({
				...video,
				updatedAt: new Date("2026-07-20T15:00:01.000Z"),
			}),
		);

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1", {
			generationId: null,
			generationStatus: null,
			chaptersJson: null,
			chaptersManuallyEditedJson: null,
			transcriptionStatus: "COMPLETE",
			updatedAtJson: "2026-07-20T15:00:00.000Z",
		});

		expect(result).toEqual({
			success: true,
			message: "AI generation changed since backfill scan",
		});
		expect(mockDb).toHaveBeenCalledTimes(1);
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("skips a backfill claim when transcription changed after the scan", async () => {
		mockDb.mockReturnValueOnce(
			makeSelectChain({
				...video,
				transcriptionStatus: "PROCESSING",
			}),
		);

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1", {
			generationId: null,
			generationStatus: null,
			chaptersJson: null,
			chaptersManuallyEditedJson: null,
			transcriptionStatus: "COMPLETE",
			updatedAtJson: "2026-07-20T15:00:00.000Z",
		});

		expect(result).toEqual({
			success: true,
			message: "AI generation changed since backfill scan",
		});
		expect(mockDb).toHaveBeenCalledTimes(1);
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("retries completed metadata when its automatic chapter array is empty", async () => {
		const incompleteVideo = {
			...video,
			metadata: {
				aiGenerationStatus: "COMPLETE",
				chapters: [],
			},
		};
		mockDb
			.mockReturnValueOnce(makeSelectChain(incompleteVideo))
			.mockReturnValueOnce(makeUpdateChain(1));

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1");

		expect(result).toEqual({
			success: true,
			message: "AI generation workflow started",
		});
		expect(mockStart).toHaveBeenCalledOnce();
	});

	it("does not regenerate an explicitly manual empty chapter state", async () => {
		const manualVideo = {
			...video,
			metadata: {
				aiGenerationStatus: "COMPLETE",
				chapters: [],
				chaptersManuallyEdited: true,
			},
		};
		mockDb.mockReturnValueOnce(makeSelectChain(manualVideo));

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1");

		expect(result).toEqual({
			success: true,
			message: "AI metadata already generated",
		});
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("protects manual chapters even when the prior generation status is stale", async () => {
		const manualVideo = {
			...video,
			metadata: {
				aiGenerationStatus: "ERROR",
				chapters: [{ title: "Owner chapter", start: 0 }],
				chaptersManuallyEdited: true,
			},
		};
		mockDb.mockReturnValueOnce(makeSelectChain(manualVideo));

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1");

		expect(result).toEqual({
			success: true,
			message: "Manual chapters are protected",
		});
		expect(mockStart).not.toHaveBeenCalled();
		expect(mockDb).toHaveBeenCalledTimes(1);
	});

	it("atomically fences the observed manual flag and chapter state", async () => {
		const update = makeUpdateChain(0);
		mockDb
			.mockReturnValueOnce(
				makeSelectChain({
					...video,
					metadata: {
						aiGenerationStatus: "ERROR",
						aiGenerationId: "old-generation",
						chapters: [],
					},
				}),
			)
			.mockReturnValueOnce(update);

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1");

		expect(result.message).toBe("AI generation already in progress");
		expect(mockStart).not.toHaveBeenCalled();
		const claimConditions = JSON.stringify(update.where.mock.calls[0]?.[0]);
		expect(claimConditions).toContain("$.chaptersManuallyEdited");
		expect(claimConditions).toContain("$.chapters");
		expect(claimConditions).toContain("videos.transcriptionStatus");
		expect(claimConditions).toContain("videos.updatedAt");
	});

	it("retries completed metadata when its chapter array is malformed", async () => {
		const malformedVideo = {
			...video,
			metadata: {
				aiGenerationStatus: "COMPLETE",
				chapters: [{ title: "", start: 0 }],
			},
		};
		mockDb
			.mockReturnValueOnce(makeSelectChain(malformedVideo))
			.mockReturnValueOnce(makeUpdateChain(1));

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1");

		expect(result).toEqual({
			success: true,
			message: "AI generation workflow started",
		});
		expect(mockStart).toHaveBeenCalledOnce();
	});

	it("marks only the queued generation as errored when start fails", async () => {
		mockDb
			.mockReturnValueOnce(makeSelectChain(video))
			.mockReturnValueOnce(makeUpdateChain(1))
			.mockReturnValueOnce(makeUpdateChain(1));
		mockStart.mockRejectedValueOnce(new Error("workflow unavailable"));

		const { startAiGeneration } = await import("@/lib/generate-ai");
		const result = await startAiGeneration("video-1" as never, "user-1");

		expect(result).toEqual({
			success: false,
			message: "Failed to start AI generation workflow",
		});
		expect(mockDb).toHaveBeenCalledTimes(3);
		const cleanup = mockDb.mock.results[2]?.value;
		expect(cleanup.set.mock.calls[0]?.[0].metadata.strings.join("")).toContain(
			"IF",
		);
		expect(cleanup.set.mock.calls[0]?.[0].metadata.strings.join("")).toContain(
			"JSON_REMOVE",
		);
		expect(cleanup.set.mock.calls[0]?.[0].metadata.strings.join("")).toContain(
			"$.aiChapterBackfillGenerationId",
		);
	});
});

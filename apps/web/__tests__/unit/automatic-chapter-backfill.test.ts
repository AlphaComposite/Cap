import { describe, expect, it, vi } from "vitest";
import {
	type AutomaticChapterBackfillRow,
	classifyAutomaticChapterBackfill,
	parseAutomaticChapterBackfillArgs,
	runAutomaticChapterBackfill,
} from "@/lib/automatic-chapter-backfill";

const baseRow: AutomaticChapterBackfillRow = {
	id: "video-1",
	ownerId: "owner-private",
	duration: 120,
	transcriptionStatus: "COMPLETE",
	updatedAt: new Date("2026-07-20T15:00:00.000Z"),
	metadata: {},
};

describe("automatic chapter backfill argument parsing", () => {
	it("defaults to dry-run and accepts exact targeting with a bounded limit", () => {
		expect(
			parseAutomaticChapterBackfillArgs([
				"--video-id",
				"video-1",
				"--limit",
				"25",
			]),
		).toEqual({ apply: false, videoId: "video-1", limit: 25 });
	});

	it("requires explicit apply and rejects conflicting modes", () => {
		expect(parseAutomaticChapterBackfillArgs(["--apply"])).toEqual({
			apply: true,
			limit: 100,
		});
		expect(() =>
			parseAutomaticChapterBackfillArgs(["--apply", "--dry-run"]),
		).toThrow("cannot be combined");
	});

	it.each([
		[["--unknown"], "Unknown argument"],
		[["--video-id"], "requires a value"],
		[["--video-id", "--apply"], "requires a value"],
		[["--limit", "0"], "between 1 and 1000"],
		[["--limit", "1001"], "between 1 and 1000"],
		[["--limit", "1.5"], "between 1 and 1000"],
		[["--limit", "--apply"], "requires a value"],
	])("rejects invalid arguments %#", (argv, message) => {
		expect(() => parseAutomaticChapterBackfillArgs(argv)).toThrow(message);
	});
});

describe("automatic chapter backfill eligibility", () => {
	it("selects a missing automatic chapter state", () => {
		expect(classifyAutomaticChapterBackfill(baseRow)).toEqual({
			eligible: true,
			reason: "chapters-missing",
			chapterCount: 0,
		});
	});

	it.each([
		["automatic empty", { chapters: [] }, "chapters-empty"],
		[
			"malformed",
			{ chapters: [{ title: "", start: 0 }] },
			"chapters-malformed",
		],
		[
			"unsorted",
			{
				chapters: [
					{ title: "Later", start: 40 },
					{ title: "Earlier", start: 20 },
				],
			},
			"chapters-unsorted",
		],
		[
			"duplicate",
			{
				chapters: [
					{ title: "First", start: 20 },
					{ title: "Duplicate", start: 20 },
				],
			},
			"chapters-duplicate",
		],
		[
			"out of duration",
			{ chapters: [{ title: "Past end", start: 120 }] },
			"chapters-out-of-duration",
		],
	])("selects %s chapter state", (_label, metadata, reason) => {
		expect(
			classifyAutomaticChapterBackfill({ ...baseRow, metadata }),
		).toMatchObject({
			eligible: true,
			reason,
		});
	});

	it("selects the known legacy generated one-chapter state for a roughly 32 minute video", () => {
		expect(
			classifyAutomaticChapterBackfill({
				...baseRow,
				duration: 1972.9,
				metadata: {
					aiGenerationStatus: "COMPLETE",
					chapters: [{ title: "Only chapter", start: 0 }],
				},
			}),
		).toEqual({
			eligible: true,
			reason: "chapters-inadequate-for-duration",
			chapterCount: 1,
		});
	});

	it("skips a coherent long one-chapter state with modern generation provenance", () => {
		expect(
			classifyAutomaticChapterBackfill({
				...baseRow,
				duration: 1972.9,
				metadata: {
					aiGenerationStatus: "COMPLETE",
					aiGenerationId: "modern-generation",
					chapters: [{ title: "Coherent single topic", start: 0 }],
				},
			}),
		).toEqual({
			eligible: false,
			reason: "chapters-valid",
			chapterCount: 1,
		});
	});

	it.each([
		["missing", undefined],
		["errored", "ERROR"],
	] as const)(
		"does not infer the known stale class when generation status is %s",
		(_label, aiGenerationStatus) => {
			expect(
				classifyAutomaticChapterBackfill({
					...baseRow,
					duration: 1972.9,
					metadata: {
						...(aiGenerationStatus ? { aiGenerationStatus } : {}),
						chapters: [{ title: "Coherent single topic", start: 0 }],
					},
				}),
			).toMatchObject({ eligible: false, reason: "chapters-valid" });
		},
	);

	it.each([
		[
			"manual nonempty",
			{
				metadata: {
					chaptersManuallyEdited: true,
					chapters: [{ title: "Owner chapter", start: 0 }],
				},
			},
			"manual-chapters",
		],
		[
			"manual empty",
			{ metadata: { chaptersManuallyEdited: true, chapters: [] } },
			"manual-chapters",
		],
		[
			"active queued",
			{ metadata: { aiGenerationStatus: "QUEUED" as const, chapters: [] } },
			"generation-active",
		],
		[
			"active processing",
			{
				metadata: { aiGenerationStatus: "PROCESSING" as const, chapters: [] },
			},
			"generation-active",
		],
		[
			"incomplete transcript",
			{ transcriptionStatus: "PROCESSING" },
			"transcription-not-complete",
		],
		["invalid duration", { duration: Number.NaN }, "invalid-duration"],
	])("skips %s", (_label, overrides, reason) => {
		expect(
			classifyAutomaticChapterBackfill({ ...baseRow, ...overrides }),
		).toMatchObject({ eligible: false, reason });
	});

	it("skips a valid generated chapter state regardless of summary state", () => {
		expect(
			classifyAutomaticChapterBackfill({
				...baseRow,
				duration: 600,
				metadata: {
					aiGenerationStatus: "COMPLETE",
					chapters: [
						{ title: "Opening", start: 0 },
						{ title: "Topic", start: 300 },
					],
					summary: "must be ignored",
					summaryManuallyEdited: true,
				},
			}),
		).toEqual({
			eligible: false,
			reason: "chapters-valid",
			chapterCount: 2,
		});
	});
});

describe("automatic chapter backfill execution", () => {
	it("is non-mutating by default and emits only privacy-safe fields", async () => {
		const startGeneration = vi.fn();
		const output = await runAutomaticChapterBackfill(
			{ apply: false, limit: 100 },
			{
				listVideos: vi.fn().mockResolvedValue([
					{
						...baseRow,
						metadata: {
							summary: "private summary",
							transcript: "private transcript",
							objectKey: "private/object/key",
						},
					},
				]),
				startGeneration,
			},
		);

		expect(startGeneration).not.toHaveBeenCalled();
		expect(output).toEqual([
			{
				videoId: "video-1",
				duration: 120,
				currentChapterCount: 0,
				reason: "chapters-missing",
				status: "would-start",
			},
		]);
		expect(JSON.stringify(output)).not.toMatch(
			/private summary|private transcript|owner-private|object\/key/,
		);
	});

	it("passes exact targeting and limit to candidate discovery", async () => {
		const listVideos = vi.fn().mockResolvedValue([]);
		await runAutomaticChapterBackfill(
			{ apply: false, videoId: "exact-video", limit: 7 },
			{ listVideos, startGeneration: vi.fn() },
		);
		expect(listVideos).toHaveBeenCalledWith({
			videoId: "exact-video",
			limit: 7,
		});
	});

	it("starts eligible apply candidates through normal generation and reports failures as retryable", async () => {
		const summary = "owner summary must remain byte-for-byte\nunchanged";
		const rows = [
			{ ...baseRow, id: "started", metadata: { summary } },
			{ ...baseRow, id: "failed", metadata: { summary } },
		];
		const startGeneration = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				message: "AI generation workflow started",
			})
			.mockResolvedValueOnce({
				success: false,
				message: "sensitive provider failure details",
			});

		const output = await runAutomaticChapterBackfill(
			{ apply: true, limit: 2 },
			{ listVideos: vi.fn().mockResolvedValue(rows), startGeneration },
		);

		expect(startGeneration).toHaveBeenNthCalledWith(
			1,
			"started",
			"owner-private",
			{
				generationId: null,
				generationStatus: null,
				chaptersJson: null,
				chaptersManuallyEditedJson: null,
				transcriptionStatus: "COMPLETE",
				updatedAtJson: "2026-07-20T15:00:00.000Z",
			},
		);
		expect(startGeneration).toHaveBeenNthCalledWith(
			2,
			"failed",
			"owner-private",
			{
				generationId: null,
				generationStatus: null,
				chaptersJson: null,
				chaptersManuallyEditedJson: null,
				transcriptionStatus: "COMPLETE",
				updatedAtJson: "2026-07-20T15:00:00.000Z",
			},
		);
		expect(
			output.map(({ videoId, reason, status }) => ({
				videoId,
				reason,
				status,
			})),
		).toEqual([
			{ videoId: "started", reason: "chapters-missing", status: "started" },
			{ videoId: "failed", reason: "start-failed", status: "retryable" },
		]);
		expect(rows[0]?.metadata?.summary).toBe(summary);
		expect(JSON.stringify(output)).not.toContain(
			"sensitive provider failure details",
		);
	});

	it("truthfully skips when a concurrent edit or generation wins the claim", async () => {
		const startGeneration = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				message: "AI metadata already generated",
			})
			.mockResolvedValueOnce({
				success: true,
				message: "AI generation already in progress",
			});
		const output = await runAutomaticChapterBackfill(
			{ apply: true, limit: 2 },
			{
				listVideos: vi.fn().mockResolvedValue([
					{ ...baseRow, id: "manual-edit-won" },
					{ ...baseRow, id: "generation-won" },
				]),
				startGeneration,
			},
		);
		expect(
			output.map(({ videoId, reason, status }) => ({
				videoId,
				reason,
				status,
			})),
		).toEqual([
			{
				videoId: "manual-edit-won",
				reason: "concurrent-change",
				status: "skipped",
			},
			{
				videoId: "generation-won",
				reason: "concurrent-change",
				status: "skipped",
			},
		]);
	});

	it("skips active, manual, and already valid states without starting generation", async () => {
		const startGeneration = vi.fn();
		const output = await runAutomaticChapterBackfill(
			{ apply: true, limit: 3 },
			{
				listVideos: vi.fn().mockResolvedValue([
					{
						...baseRow,
						id: "active",
						metadata: { aiGenerationStatus: "QUEUED", chapters: [] },
					},
					{
						...baseRow,
						id: "manual",
						metadata: { chaptersManuallyEdited: true, chapters: [] },
					},
					{
						...baseRow,
						id: "valid",
						metadata: { chapters: [{ title: "Opening", start: 0 }] },
					},
				]),
				startGeneration,
			},
		);
		expect(startGeneration).not.toHaveBeenCalled();
		expect(output.map(({ reason, status }) => ({ reason, status }))).toEqual([
			{ reason: "generation-active", status: "skipped" },
			{ reason: "manual-chapters", status: "skipped" },
			{ reason: "chapters-valid", status: "skipped" },
		]);
	});
});

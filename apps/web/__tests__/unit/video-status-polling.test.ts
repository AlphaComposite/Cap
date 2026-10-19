import { describe, expect, it, vi } from "vitest";
import { shouldContinueVideoStatusPolling } from "@/lib/video-status-polling";

const available = {
	aiGeneration: true,
	transcriptionGeneration: true,
};

const completeStatus = (overrides: Record<string, unknown> = {}) => ({
	transcriptionStatus: "COMPLETE",
	aiGenerationStatus: null,
	summary: null,
	chapters: null,
	...overrides,
});

describe("shouldContinueVideoStatusPolling", () => {
	it("keeps polling a matching pending chapter regeneration after full AI completed", () => {
		const now = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		expect(
			shouldContinueVideoStatusPolling(
				completeStatus({
					aiGenerationStatus: "COMPLETE",
					chaptersRegenerationRevisionId: "rev-1",
					chaptersRegenerationQueuedAt: now - 179_999,
				}),
				available,
				"rev-1",
			),
		).toBe(true);
	});

	it.each([
		{ label: "cleared", revisionId: null, queuedAt: null, playback: "rev-1" },
		{
			label: "other revision",
			revisionId: "rev-2",
			queuedAt: 1_800_000_000_000,
			playback: "rev-1",
		},
		{
			label: "legacy playback",
			revisionId: "rev-1",
			queuedAt: 1_800_000_000_000,
			playback: null,
		},
		{
			label: "expired",
			revisionId: "rev-1",
			queuedAt: 1_800_000_000_000 - 180_000,
			playback: "rev-1",
		},
		{
			label: "missing timestamp",
			revisionId: "rev-1",
			queuedAt: null,
			playback: "rev-1",
		},
		{
			label: "future timestamp",
			revisionId: "rev-1",
			queuedAt: 1_800_000_000_001,
			playback: "rev-1",
		},
	])(
		"stops chapter polling for $label",
		({ revisionId, queuedAt, playback }) => {
			vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
			expect(
				shouldContinueVideoStatusPolling(
					completeStatus({
						aiGenerationStatus: "COMPLETE",
						chaptersRegenerationRevisionId: revisionId,
						chaptersRegenerationQueuedAt: queuedAt,
					}),
					available,
					playback,
				),
			).toBe(false);
		},
	);
	it("continues when a summary exists but chapters and AI status are absent", () => {
		expect(
			shouldContinueVideoStatusPolling(
				completeStatus({ summary: "A pasted summary" }),
				available,
			),
		).toBe(true);
	});

	it("follows transcription availability before transcription starts", () => {
		expect(
			shouldContinueVideoStatusPolling(
				{ transcriptionStatus: null, aiGenerationStatus: null },
				{ ...available, transcriptionGeneration: true },
			),
		).toBe(true);
		expect(
			shouldContinueVideoStatusPolling(
				{ transcriptionStatus: null, aiGenerationStatus: null },
				{ ...available, transcriptionGeneration: false },
			),
		).toBe(false);
	});

	it("continues while transcription is processing", () => {
		expect(
			shouldContinueVideoStatusPolling(
				{ transcriptionStatus: "PROCESSING", aiGenerationStatus: null },
				available,
			),
		).toBe(true);
	});

	it.each(["ERROR", "SKIPPED", "NO_AUDIO"])(
		"stops after transcription status %s",
		(transcriptionStatus) => {
			expect(
				shouldContinueVideoStatusPolling(
					{ transcriptionStatus, aiGenerationStatus: null },
					available,
				),
			).toBe(false);
		},
	);

	it("stops after transcription completes when AI generation is unavailable", () => {
		expect(
			shouldContinueVideoStatusPolling(completeStatus(), {
				...available,
				aiGeneration: false,
			}),
		).toBe(false);
	});

	it.each(["ERROR", "SKIPPED", "COMPLETE"])(
		"stops after AI status %s",
		(aiGenerationStatus) => {
			expect(
				shouldContinueVideoStatusPolling(
					completeStatus({ aiGenerationStatus }),
					available,
				),
			).toBe(false);
		},
	);

	it.each([null, "QUEUED", "PROCESSING"])(
		"continues after transcription completes with AI status %s",
		(aiGenerationStatus) => {
			expect(
				shouldContinueVideoStatusPolling(
					completeStatus({ aiGenerationStatus }),
					available,
				),
			).toBe(true);
		},
	);

	it("stops for an unknown terminal transcription status", () => {
		expect(
			shouldContinueVideoStatusPolling(
				{ transcriptionStatus: "UNKNOWN", aiGenerationStatus: null },
				available,
			),
		).toBe(false);
	});
});

import { describe, expect, it } from "vitest";
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiModelSelection } from "@/lib/ai/provider";

const generateTextMock = vi.hoisted(() => vi.fn());
const getAiProviderChainMock = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({
	generateText: generateTextMock,
	APICallError: { isInstance: () => false },
}));

vi.mock("@/lib/ai/provider", () => ({
	getAiProviderChain: getAiProviderChainMock,
	isAiConfigured: vi.fn(() => true),
}));

vi.mock("@cap/database", () => ({
	db: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
}));

vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {},
}));

vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: vi.fn(),
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: vi.fn(),
}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));

vi.mock("server-only", () => ({}));

import { AiUnavailableError } from "@/lib/ai/run";
import {
	callAiApi,
	getMinimumUsefulChapterCount,
	getRequiredChapterSynthesisCount,
	parseAiResponse,
	parseChapterSynthesis,
	parseChunkAnalysis,
	parseFinalSummary,
} from "@/workflows/generate-ai";

const makeSelection = (provider: string): AiModelSelection => ({
	provider: provider as AiModelSelection["provider"],
	modelId: `${provider}-model`,
	model: () => ({}) as ReturnType<AiModelSelection["model"]>,
	supportsStreaming: true,
	supportsTemperature: true,
	defaultMaxOutputTokens: 8000,
});

const VALID_JSON =
	'{"title":"Workflow review","summary":"I explain the workflow.","chapters":[]}';

describe("callAiApi provider fallback on invalid output", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "error").mockImplementation(() => {});
		getAiProviderChainMock.mockReturnValue([
			makeSelection("groq"),
			makeSelection("openai"),
		]);
	});

	it("falls through to the next provider when a fulfilled response is malformed", async () => {
		generateTextMock
			.mockResolvedValueOnce({ text: "I could not produce JSON" })
			.mockResolvedValueOnce({ text: VALID_JSON });

		await expect(callAiApi("prompt", parseAiResponse)).resolves.toEqual({
			title: "Workflow review",
			summary: "I explain the workflow.",
			chapters: [],
		});
		expect(generateTextMock).toHaveBeenCalledTimes(2);
	});

	it("falls through to the next provider when a fulfilled response is empty or truncated", async () => {
		generateTextMock
			.mockResolvedValueOnce({ text: "" })
			.mockResolvedValueOnce({ text: '{"title":"Cut off","summary":"' })
			.mockResolvedValueOnce({ text: VALID_JSON });
		getAiProviderChainMock.mockReturnValue([
			makeSelection("groq"),
			makeSelection("openai"),
			makeSelection("anthropic"),
		]);

		await expect(callAiApi("prompt", parseAiResponse)).resolves.toMatchObject({
			title: "Workflow review",
		});
		expect(generateTextMock).toHaveBeenCalledTimes(3);
	});

	it("marks the terminal failure as invalid output when every provider returns unusable text", async () => {
		generateTextMock.mockResolvedValue({ text: "still not JSON" });

		const error = await callAiApi("prompt", parseAiResponse).catch(
			(caught) => caught,
		);

		expect(error).toBeInstanceOf(AiUnavailableError);
		expect((error.cause as Error).name).toBe("InvalidAiOutputError");
	});

	it("falls through when valid JSON is missing required fields", async () => {
		generateTextMock
			.mockResolvedValueOnce({ text: '{"chapters":[]}' })
			.mockResolvedValueOnce({
				text: '{"title":"Workflow review","summary":"I explain the workflow."}',
			});

		await expect(callAiApi("prompt", parseFinalSummary)).resolves.toEqual({
			title: "Workflow review",
			summary: "I explain the workflow.",
		});
		expect(generateTextMock).toHaveBeenCalledTimes(2);
	});

	it("keeps request-level chain failures distinguishable from invalid output", async () => {
		const outage = new Error("connect ECONNREFUSED");
		generateTextMock
			.mockResolvedValueOnce({ text: "not JSON" })
			.mockRejectedValueOnce(outage);

		const error = await callAiApi("prompt", parseAiResponse).catch(
			(caught) => caught,
		);

		expect(error).toBeInstanceOf(AiUnavailableError);
		expect(error.cause).toBe(outage);
	});

	it("retries a long multi-section chapter synthesis when one generic chapter is returned", async () => {
		generateTextMock
			.mockResolvedValueOnce({
				text: '{"chapters":[{"title":"Overview","start":0}]}',
			})
			.mockResolvedValueOnce({
				text: '{"chapters":[{"title":"Onboarding","start":0},{"title":"Billing changes","start":960}]}',
			});

		await expect(
			callAiApi("prompt", (text) => parseChapterSynthesis(text, 2)),
		).resolves.toEqual([
			{ title: "Onboarding", start: 0 },
			{ title: "Billing changes", start: 960 },
		]);
		expect(generateTextMock).toHaveBeenCalledTimes(2);
	});
});

describe("useful chapter coverage", () => {
	const distinctSections = [
		{ title: "Onboarding", start: 0 },
		{ title: "Billing changes", start: 960 },
	];

	it("requires multiple chapters only for long transcripts with distinct section candidates", () => {
		expect(getMinimumUsefulChapterCount(30 * 60, distinctSections)).toBe(2);
		expect(getMinimumUsefulChapterCount(45 * 60, distinctSections)).toBe(2);
		// Transcript duration is estimated from the final cue start, so allow the
		// final cue of a 30-minute recording to begin up to a minute earlier.
		expect(getMinimumUsefulChapterCount(29 * 60, distinctSections)).toBe(2);
		expect(getMinimumUsefulChapterCount(28 * 60, distinctSections)).toBe(0);
		expect(
			getMinimumUsefulChapterCount(45 * 60, distinctSections.slice(0, 1)),
		).toBe(0);
	});

	it("does not force synthesis for a long multi-chunk single-topic analysis", () => {
		const mechanicallySplitCandidates = Array.from(
			{ length: 6 },
			(_, index) => ({
				title:
					index % 2 === 0 ? "Product walkthrough" : " product WALKTHROUGH ",
				start: index * 450,
			}),
		);

		expect(
			getMinimumUsefulChapterCount(45 * 60, mechanicallySplitCandidates),
		).toBe(0);
	});

	it("requires synthesis when distinct candidates collapse below the coverage floor", () => {
		expect(
			getRequiredChapterSynthesisCount(45 * 60, [
				{ title: "Onboarding", start: 0 },
				{ title: "Billing changes", start: 20 },
			]),
		).toBe(2);
		expect(
			getRequiredChapterSynthesisCount(45 * 60, [
				{ title: "Product walkthrough", start: 0 },
				{ title: " product WALKTHROUGH ", start: 20 },
			]),
		).toBe(0);
	});

	it("rejects a generic single chapter when multiple chapters are required", () => {
		expect(() =>
			parseChapterSynthesis('{"chapters":[{"title":"Overview","start":0}]}', 2),
		).toThrow("at least 2 useful chapters");
	});

	it("does not force chapters when the transcript lacks multi-section evidence", () => {
		expect(parseChapterSynthesis('{"chapters":[]}', 0)).toEqual([]);
	});

	it("does not count duplicate generic titles as useful coverage", () => {
		expect(() =>
			parseChapterSynthesis(
				'{"chapters":[{"title":"Overview","start":0},{"title":" overview ","start":900}]}',
				2,
			),
		).toThrow("distinct chapter titles");
	});
});

describe("map-reduce output parsers", () => {
	it("parseChunkAnalysis rejects missing or empty section summaries", () => {
		expect(() => parseChunkAnalysis("{}")).toThrow();
		expect(() =>
			parseChunkAnalysis('{"summary":"  ","keyPoints":[],"chapters":[]}'),
		).toThrow();
	});

	it("parseChunkAnalysis defaults optional arrays", () => {
		expect(parseChunkAnalysis('{"summary":"Covers the retry queue."}')).toEqual(
			{
				summary: "Covers the retry queue.",
				keyPoints: [],
				chapters: [],
			},
		);
	});

	it("parseChunkAnalysis sanitizes malformed array fields", () => {
		expect(
			parseChunkAnalysis(
				'{"summary":"Covers the retry queue.","keyPoints":"one point","chapters":{"title":"Intro"}}',
			),
		).toEqual({
			summary: "Covers the retry queue.",
			keyPoints: [],
			chapters: [],
		});

		expect(
			parseChunkAnalysis(
				'{"summary":"Covers the retry queue.","keyPoints":["kept",42,null],"chapters":[{"title":"Intro","start":0},{"title":"","start":5},{"title":"No start"},{"start":9},null,"Outro"]}',
			),
		).toEqual({
			summary: "Covers the retry queue.",
			keyPoints: ["kept"],
			chapters: [{ title: "Intro", start: 0 }],
		});
	});

	it("parseFinalSummary rejects missing or empty required fields", () => {
		expect(() => parseFinalSummary('{"title":"Only a title"}')).toThrow();
		expect(() => parseFinalSummary('{"summary":"Only a summary"}')).toThrow();
		expect(() => parseFinalSummary('{"title":"","summary":""}')).toThrow();
	});
});

import { readFileSync } from "node:fs";
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
import { hasValidChapterState } from "@/lib/ai-chapter-state";
import {
	getMinimumUsefulChapterCount,
	getRequiredChapterSynthesisCount,
	validateChapterStartsInSection,
	validateGeneratedChapters,
} from "@/lib/ai-chapter-validation";
import {
	callAiApi,
	conciseGeneratedTitleGuidance,
	generateTitleForChapters,
	parseAiResponse,
	parseChapterSynthesis,
	parseChunkAnalysis,
	parseFinalTitle,
	strictTitleRetry,
} from "@/workflows/generate-ai";

const makeSelection = (provider: string): AiModelSelection => {
	const model = { provider } as ReturnType<AiModelSelection["model"]>;
	return {
		provider: provider as AiModelSelection["provider"],
		modelId: `${provider}-model`,
		model: () => model,
		supportsStreaming: true,
		supportsTemperature: true,
		defaultMaxOutputTokens: 8000,
	};
};

const VALID_JSON = '{"title":"Workflow review","chapters":[]}';

describe("generated metadata ownership", () => {
	it("keeps workflow completion writes scoped to generated chapters and title", () => {
		const source = readFileSync(
			new URL("../../workflows/generate-ai.ts", import.meta.url),
			"utf8",
		);
		const helperStart = source.indexOf("function buildGeneratedMetadataUpdate");
		const helperEnd = source.indexOf("async function saveResults", helperStart);
		const helperSource = source.slice(helperStart, helperEnd);

		expect(helperStart).toBeGreaterThanOrEqual(0);
		expect(source).not.toContain(
			"export function buildGeneratedMetadataUpdate",
		);
		expect(helperSource).toContain('"chapters"');
		expect(helperSource).not.toContain("$.summary");
	});

	it("keeps AI result and chapter validation types out of the workflow exports", () => {
		const source = readFileSync(
			new URL("../../workflows/generate-ai.ts", import.meta.url),
			"utf8",
		);

		expect(source).not.toMatch(/export (interface|type) AiResult/);
		expect(source).not.toMatch(
			/export (interface|type) ChapterTranscriptEvidence/,
		);
		expect(source).not.toMatch(/export function validateGeneratedChapters/);
	});
});

describe("chapter state validation", () => {
	it("accepts a valid state and rejects malformed chapter entries", () => {
		expect(
			hasValidChapterState([{ title: "Opening", start: 0 }], 90, false),
		).toBe(true);
		expect(hasValidChapterState([{ title: "", start: 0 }], 90, false)).toBe(
			false,
		);
		expect(
			hasValidChapterState(
				[{ title: "Opening", start: Number.NaN }],
				90,
				false,
			),
		).toBe(false);
	});
});

describe("callAiApi provider fallback on invalid output", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
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

	it("repairs a 96-character title on the same model with specific guidance", async () => {
		generateTextMock
			.mockResolvedValueOnce({
				text: JSON.stringify({ title: "x".repeat(96), chapters: [] }),
			})
			.mockResolvedValueOnce({ text: VALID_JSON });

		await expect(callAiApi("prompt", parseAiResponse)).resolves.toEqual({
			title: "Workflow review",
			chapters: [],
		});
		expect(generateTextMock).toHaveBeenCalledTimes(2);
		const [first, second] = generateTextMock.mock.calls.map(([args]) => args);
		expect(second.model).toBe(first.model);
		expect(second.prompt).toContain("title has 96 characters; maximum is 60");
		expect(second.prompt).toContain("Shorten it to the main subject");
		expect(second.prompt).toContain("counting spaces");
	});

	it("repairs a missing title on the same model", async () => {
		generateTextMock
			.mockResolvedValueOnce({ text: '{"chapters":[]}' })
			.mockResolvedValueOnce({
				text: '{"title":"Workflow review"}',
			});

		await expect(callAiApi("prompt", parseFinalTitle)).resolves.toEqual({
			title: "Workflow review",
		});
		expect(generateTextMock).toHaveBeenCalledTimes(2);
		expect(generateTextMock.mock.calls[1][0].model).toBe(
			generateTextMock.mock.calls[0][0].model,
		);
		expect(generateTextMock.mock.calls[1][0].prompt).toContain(
			"title property is missing",
		);
	});

	it.each([
		[
			{},
			"title property is missing",
			"Return a JSON object with a title property",
		],
		[
			{ title: 42 },
			"title has type number, expected string",
			"Replace it with a nonblank string",
		],
		[
			{ title: null },
			"title has type null, expected string",
			"Replace it with a nonblank string",
		],
		[
			{ title: " \n	 " },
			"title is blank after trimming",
			"Supply a nonblank title naming the main subject",
		],
	])("gives safe WHY/HOW for invalid title %j", async (output, why, how) => {
		generateTextMock
			.mockResolvedValueOnce({ text: JSON.stringify(output) })
			.mockResolvedValueOnce({ text: '{"title":"Billing migration"}' });
		await expect(
			callAiApi("Original language instruction", parseFinalTitle),
		).resolves.toEqual({ title: "Billing migration" });
		expect(generateTextMock).toHaveBeenCalledTimes(2);
		const [first, second] = generateTextMock.mock.calls.map(([args]) => args);
		expect(second.model).toBe(first.model);
		for (const detail of ["Original language instruction", why, how, "60"])
			expect(second.prompt).toContain(detail);
	});

	it.each([parseFinalTitle, parseAiResponse])(
		"omits only an exhausted title without selecting B (%s)",
		async (parse) => {
			const chapters = [{ title: "Billing migration", start: 0 }];
			generateTextMock.mockResolvedValue({
				text: JSON.stringify({ title: " ", chapters }),
			});
			await expect(callAiApi("prompt", parse)).resolves.toEqual(
				parse === parseFinalTitle ? {} : { chapters },
			);
			expect(generateTextMock).toHaveBeenCalledTimes(2);
			expect(generateTextMock.mock.calls[1][0].model).toBe(
				generateTextMock.mock.calls[0][0].model,
			);
			expect(console.error).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ title: "Corrected" },
		{ title: "Corrected", chapters: [{ title: "Replacement", start: 30 }] },
		{ title: null },
		{ title: null, chapters: [{ title: "Replacement", start: 30 }] },
		{ title: "Corrected", chapters: "invalid and ignored" },
	])(
		"retains accepted chapters through title-only correction %j",
		async (correction) => {
			const chapters = [{ title: "First", start: 0 }];
			generateTextMock
				.mockResolvedValueOnce({
					text: JSON.stringify({ title: "", chapters }),
				})
				.mockResolvedValueOnce({ text: JSON.stringify(correction) });
			await expect(callAiApi("prompt", parseAiResponse)).resolves.toEqual({
				...(correction.title ? { title: correction.title } : {}),
				chapters,
			});
			expect(generateTextMock).toHaveBeenCalledTimes(2);
			expect(generateTextMock.mock.calls[1][0].model).toBe(
				generateTextMock.mock.calls[0][0].model,
			);
			expect(generateTextMock.mock.calls[1][0].prompt).toContain(
				"Do not regenerate chapters",
			);
		},
	);

	it("retains accepted chapters when a title correction request falls back", async () => {
		const chapters = [{ title: "First", start: 0 }];
		generateTextMock
			.mockResolvedValueOnce({ text: JSON.stringify({ title: "", chapters }) })
			.mockRejectedValueOnce(new Error("request unavailable"))
			.mockResolvedValueOnce({ text: '{"title":"Corrected"}' });
		await expect(callAiApi("prompt", parseAiResponse)).resolves.toEqual({
			title: "Corrected",
			chapters,
		});
		expect(generateTextMock).toHaveBeenCalledTimes(3);
		expect(generateTextMock.mock.calls[2][0].model).not.toBe(
			generateTextMock.mock.calls[0][0].model,
		);
	});

	it.each([false, true])(
		"retains API-error fallback (during correction: %s)",
		async (duringCorrection) => {
			if (duringCorrection)
				generateTextMock.mockResolvedValueOnce({ text: '{"title":""}' });
			generateTextMock
				.mockRejectedValueOnce(new Error("request unavailable"))
				.mockResolvedValueOnce({ text: '{"title":"Billing migration"}' });
			await expect(callAiApi("prompt", parseFinalTitle)).resolves.toEqual({
				title: "Billing migration",
			});
			const models = generateTextMock.mock.calls.map(([args]) => args.model);
			expect(models).toHaveLength(duringCorrection ? 3 : 2);
			if (duringCorrection) expect(models[1]).toBe(models[0]);
			expect(models.at(-1)).not.toBe(models[0]);
		},
	);

	it("still falls back for invalid original chapters without accepting them", async () => {
		generateTextMock
			.mockResolvedValueOnce({
				text: '{"title":"","chapters":[{"title":"","start":0}]}',
			})
			.mockResolvedValueOnce({ text: VALID_JSON });
		await expect(callAiApi("prompt", parseAiResponse)).resolves.toEqual({
			title: "Workflow review",
			chapters: [],
		});
		expect(generateTextMock).toHaveBeenCalledTimes(2);
		expect(generateTextMock.mock.calls[1][0].model).not.toBe(
			generateTextMock.mock.calls[0][0].model,
		);
	});

	it("bounds post-edit exhaustion to two calls and preserves the existing name via null", async () => {
		generateTextMock.mockResolvedValue({ text: '{"title":""}' });
		await expect(
			generateTitleForChapters([{ title: "Billing", start: 0 }], "auto"),
		).resolves.toBeNull();
		expect(generateTextMock).toHaveBeenCalledTimes(2);
		expect(generateTextMock.mock.calls[1][0].model).toBe(
			generateTextMock.mock.calls[0][0].model,
		);
	});

	it("does not start another post-edit round after malformed JSON exhausts the chain", async () => {
		generateTextMock.mockResolvedValue({
			text: '{"title":PRIVATE_JSON_MARKER}',
		});
		await expect(
			generateTitleForChapters([{ title: "Billing", start: 0 }], "auto"),
		).resolves.toBeNull();
		expect(generateTextMock).toHaveBeenCalledTimes(2);
		expect(generateTextMock.mock.calls[1][0].model).not.toBe(
			generateTextMock.mock.calls[0][0].model,
		);
	});

	it("logs only safe validation fields, never rejected content or original context", async () => {
		const rejected = "REJECTED_PRIVATE_TITLE ".repeat(5);
		generateTextMock.mockResolvedValue({
			text: JSON.stringify({ title: rejected }),
		});
		await expect(
			callAiApi("PRIVATE_TRANSCRIPT_MARKER", parseFinalTitle),
		).resolves.toEqual({});
		const logs = JSON.stringify([
			vi.mocked(console.error).mock.calls,
			vi.mocked(console.warn).mock.calls,
			vi.mocked(console.log).mock.calls,
		]);
		expect(logs).not.toContain("REJECTED_PRIVATE_TITLE");
		expect(logs).not.toContain("PRIVATE_TRANSCRIPT_MARKER");
		expect(console.error).not.toHaveBeenCalled();
		expect(console.warn).toHaveBeenCalledWith("[ai-title-validation]", {
			reason: "overlong",
			characterCount: rejected.trim().length,
			attempt: 2,
			provider: "groq",
			model: "groq-model",
		});
	});

	it("sanitizes JSON parser failures before provider logs and error causes", async () => {
		generateTextMock.mockResolvedValue({
			text: '{"title":PRIVATE_JSON_MARKER}',
		});
		const error = await callAiApi(
			"PRIVATE_TRANSCRIPT_MARKER",
			parseFinalTitle,
		).catch((caught) => caught);
		expect(error).toBeInstanceOf(AiUnavailableError);
		expect(error.cause.cause).toBeUndefined();
		expect(error.cause.message).not.toContain("PRIVATE_JSON_MARKER");
		for (const call of vi.mocked(console.error).mock.calls) {
			expect(String(call[1])).not.toContain("PRIVATE_JSON_MARKER");
			expect((call[1] as Error).cause).toBeUndefined();
		}
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

	it("retries and rejects a final-chunk boundary instead of fabricating start zero", async () => {
		generateTextMock.mockResolvedValue({
			text: '{"summary":"Final cue.","chapters":[{"title":"After the video","start":120}]}',
		});

		const error = await callAiApi("prompt", (text) => {
			const parsed = parseChunkAnalysis(text);
			validateChapterStartsInSection(
				parsed.chapters,
				{ startTime: 0, endTime: 120 },
				120,
			);
			return parsed;
		}).catch((caught) => caught);

		expect(error).toBeInstanceOf(AiUnavailableError);
		expect(generateTextMock).toHaveBeenCalledTimes(2);
		expect(error).not.toEqual({
			summary: "Final cue.",
			keyPoints: [],
			chapters: [{ title: "After the video", start: 0 }],
		});
	});
});

describe("useful chapter coverage", () => {
	it("adds an opening chapter for a coherent short transcript", () => {
		expect(
			validateGeneratedChapters([], 90, [
				{ start: 4, text: "Welcome to the product walkthrough." },
			]),
		).toEqual([{ title: "Opening", start: 4 }]);
	});

	it("rejects chapter timestamps outside the transcript duration", () => {
		expect(() =>
			validateGeneratedChapters(
				[
					{ title: "Opening", start: 0 },
					{ title: "After the video", start: 1000 },
				],
				90,
				[{ start: 0, text: "Opening remarks." }],
			),
		).toThrow("invalid chapter");
	});

	it("accepts chapter starts aligned with real transcript cues", () => {
		expect(
			validateGeneratedChapters(
				[
					{ title: "Opening", start: 4 },
					{ title: "Billing", start: 30 },
				],
				100,
				[
					{ start: 4, text: "Welcome to the walkthrough." },
					{ start: 30, text: "Now we cover billing." },
					{ start: 70, text: "Finally, mobile details." },
				],
			),
		).toEqual([
			{ title: "Opening", start: 4 },
			{ title: "Billing", start: 30 },
		]);
	});

	it("allows only a small numeric serialization tolerance around a cue start", () => {
		expect(
			validateGeneratedChapters([{ title: "Billing", start: 30.5 }], 100, [
				{ start: 4, text: "Welcome to the walkthrough." },
				{ start: 30, text: "Now we cover billing." },
			]),
		).toEqual([
			{ title: "Opening", start: 4 },
			{ title: "Billing", start: 30.5 },
		]);
	});

	it("rejects arbitrary in-range chapter starts", () => {
		expect(() =>
			validateGeneratedChapters(
				[
					{ title: "Opening", start: 10 },
					{ title: "Billing", start: 50 },
				],
				100,
				[
					{ start: 4, text: "Welcome to the walkthrough." },
					{ start: 30, text: "Now we cover billing." },
					{ start: 70, text: "Finally, mobile details." },
				],
			),
		).toThrow("transcript");
	});

	it("rejects evenly sliced in-range timestamps that are not cue starts", () => {
		expect(() =>
			validateGeneratedChapters(
				[
					{ title: "Opening", start: 25 },
					{ title: "Billing", start: 50 },
					{ title: "Mobile", start: 75 },
				],
				100,
				[
					{ start: 4, text: "Welcome to the walkthrough." },
					{ start: 30, text: "Now we cover billing." },
					{ start: 70, text: "Finally, mobile details." },
				],
			),
		).toThrow("transcript");
	});

	const distinctSections = [
		{ title: "Onboarding", start: 0 },
		{ title: "Billing changes", start: 960 },
	];

	it("requires multiple chapters only for long transcripts with distinct section candidates", () => {
		expect(getMinimumUsefulChapterCount(30 * 60, distinctSections)).toBe(2);
		expect(getMinimumUsefulChapterCount(45 * 60, distinctSections)).toBe(2);
		expect(getMinimumUsefulChapterCount(29 * 60, distinctSections)).toBe(2);
		expect(getMinimumUsefulChapterCount(10 * 60, distinctSections)).toBe(2);
		expect(getMinimumUsefulChapterCount(2 * 60, distinctSections)).toBe(2);
		expect(getMinimumUsefulChapterCount(119, distinctSections)).toBe(0);
		expect(
			getMinimumUsefulChapterCount(45 * 60, distinctSections.slice(0, 1)),
		).toBe(0);
	});

	it("requires coverage when a long transcript only returns one generic chapter", () => {
		expect(
			getMinimumUsefulChapterCount(32 * 60, [{ title: "Overview", start: 0 }]),
		).toBe(2);
	});

	it("recognizes an introduction and background singleton as generic coverage", () => {
		expect(
			getMinimumUsefulChapterCount(32 * 60, [
				{ title: "Introduction and Background", start: 0 },
			]),
		).toBe(2);
	});

	it("does not complete a long transcript with only an injected opening chapter", () => {
		expect(() =>
			validateGeneratedChapters([], 32 * 60, [
				{ start: 0, text: "Onboarding details." },
				{ start: 1_200, text: "Billing and mobile details." },
			]),
		).toThrow("at least 2 useful chapters");
	});

	it("recognizes a full-recording overview as generic coverage", () => {
		expect(
			getMinimumUsefulChapterCount(
				32 * 60,
				[{ title: "Full video overview", start: 0 }],
				[
					{ start: 0, text: "Opening topic." },
					{ start: 1_200, text: "Later topic." },
				],
			),
		).toBe(2);
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

	it("does not request synthesis without timestamped chapter evidence", () => {
		expect(
			getRequiredChapterSynthesisCount(
				32 * 60,
				[],
				[
					{ start: 0, text: "Opening topic." },
					{ start: 1_200, text: "Later topic." },
				],
			),
		).toBe(0);
	});

	it("rejects a generic single chapter when multiple chapters are required", () => {
		expect(() =>
			parseChapterSynthesis('{"chapters":[{"title":"Overview","start":0}]}', 2),
		).toThrow("at least 2 useful chapters");
	});

	it("rejects structurally invalid synthesis entries instead of dropping them", () => {
		expect(() =>
			parseChapterSynthesis(
				'{"chapters":[{"title":"Opening","start":0},{"title":"","start":30}]}',
				1,
				120,
			),
		).toThrow("invalid chapter");
	});

	it("sorts valid synthesized chapters by timestamp before validation", () => {
		expect(
			parseChapterSynthesis(
				'{"chapters":[{"title":"Second","start":60},{"title":"Opening","start":0}]}',
				2,
				120,
				[
					{ start: 0, text: "Opening cue" },
					{ start: 60, text: "Second cue" },
				],
			),
		).toEqual([
			{ title: "Opening", start: 0 },
			{ title: "Second", start: 60 },
		]);
	});

	it("collapses exact duplicate synthesized starts before validation", () => {
		expect(
			parseChapterSynthesis(
				'{"chapters":[{"title":"Opening","start":0},{"title":"Duplicate opening","start":0},{"title":"Second","start":60}]}',
				2,
				120,
				[
					{ start: 0, text: "Opening cue" },
					{ start: 60, text: "Second cue" },
				],
			),
		).toEqual([
			{ title: "Opening", start: 0 },
			{ title: "Second", start: 60 },
		]);
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

	it("parseChunkAnalysis rejects malformed chapter entries", () => {
		expect(() =>
			parseChunkAnalysis(
				'{"summary":"Covers the retry queue.","keyPoints":["kept"],"chapters":[{"title":"","start":5}]}',
			),
		).toThrow("invalid chapter");
	});

	it("parseFinalTitle rejects missing or empty titles", () => {
		expect(() => parseFinalTitle("{}")).toThrow();
		expect(() => parseFinalTitle('{"title":""}')).toThrow();
		expect(parseFinalTitle('{"title":"  Workflow review  "}')).toEqual({
			title: "Workflow review",
		});
	});

	it("parseFinalTitle rejects overlong titles instead of cutting them", () => {
		expect(() =>
			parseFinalTitle(JSON.stringify({ title: "x".repeat(61) })),
		).toThrow("valid title");
		expect(() =>
			parseFinalTitle(JSON.stringify({ title: "x".repeat(256) })),
		).toThrow("valid title");
		expect(parseFinalTitle(JSON.stringify({ title: "x".repeat(60) }))).toEqual({
			title: "x".repeat(60),
		});
	});
});

describe("title retry", () => {
	it("states the full contract before all title paths without outer retries", () => {
		const guidance = conciseGeneratedTitleGuidance();
		for (const required of [
			"title",
			"JSON",
			"nonblank string",
			"60 characters",
			"including spaces",
			"specific subject",
		])
			expect(guidance).toContain(required);
		const source = readFileSync(
			new URL("../../workflows/generate-ai.ts", import.meta.url),
			"utf8",
		);
		for (const [name, nextName] of [
			["generateSingleChunk", "generateMultipleChunks"],
			["generateMultipleChunks", "generateTitleForChapters"],
			["generateTitleForChapters", "strictTitleRetry"],
		]) {
			const start = source.indexOf(`function ${name}(`);
			const body = source.slice(start, source.indexOf(`function ${nextName}(`));
			expect(body).toContain("conciseGeneratedTitleGuidance()");
			expect(body).not.toContain("strictTitleRetry()");
		}
	});
	it("restates the 60-character limit", () => {
		expect(strictTitleRetry()).toContain("60 characters or fewer");
	});
});

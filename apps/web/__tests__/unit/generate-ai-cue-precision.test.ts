import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateChapterStartsInSection } from "@/lib/ai-chapter-validation";

const state = vi.hoisted(() => ({
	video: null as Record<string, unknown> | null,
	transcript: null as string | null,
	updateResults: [] as number[],
	updates: [] as unknown[],
	conditions: [] as unknown[],
}));
const generateTextMock = vi.hoisted(() => vi.fn());
const getAiProviderChainMock = vi.hoisted(() => vi.fn());
const enqueueNameSync = vi.hoisted(() => vi.fn());

const schema = vi.hoisted(() => ({
	videos: {
		id: "videos.id",
		metadata: "videos.metadata",
		transcriptionStatus: "videos.transcriptionStatus",
		orgId: "videos.orgId",
		name: "videos.name",
	},
	organizations: {
		id: "organizations.id",
		settings: "organizations.settings",
	},
}));

vi.mock("@cap/database/schema", () => schema);
vi.mock("@cap/database", () => ({
	db: () => ({
		async transaction<T>(
			run: (tx: {
				select: () => {
					from: () => {
						where: () => { for: () => Promise<Record<string, unknown>[]> };
					};
				};
				update: () => {
					set: (values: unknown) => {
						where: (condition: unknown) => Promise<{ affectedRows: number }[]>;
					};
				};
			}) => Promise<T>,
		): Promise<T> {
			return run({
				select: () => ({
					from: () => ({
						where: () => ({
							for: async () => (state.video ? [state.video] : []),
						}),
					}),
				}),
				update: () => ({
					set: (values: unknown) => {
						state.updates.push(values);
						return {
							where: async (condition: unknown) => {
								state.conditions.push(condition);
								return [{ affectedRows: state.updateResults.shift() ?? 1 }];
							},
						};
					},
				}),
			});
		},
		select: () => {
			let joined = false;
			const query = {
				from: () => query,
				leftJoin: () => {
					joined = true;
					return query;
				},
				where: async () =>
					joined
						? [{ video: state.video, orgSettings: null }]
						: state.video
							? [state.video]
							: [],
			};
			return query;
		},
		update: () => ({
			set: (values: unknown) => {
				state.updates.push(values);
				return {
					where: async (condition: unknown) => {
						state.conditions.push(condition);
						return [
							{
								affectedRows: state.updateResults.shift() ?? 1,
							},
						];
					},
				};
			},
		}),
	}),
}));

vi.mock("drizzle-orm", () => ({
	and: (...conditions: unknown[]) => ({ type: "and", conditions }),
	eq: (left: unknown, right: unknown) => ({ type: "eq", left, right }),
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings,
		values,
	}),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					getObject: () =>
						state.transcript === null
							? Effect.succeed(Option.none())
							: Effect.succeed(Option.some(state.transcript)),
				},
			]),
	},
}));
vi.mock("@/lib/ai/provider", () => ({
	getAiProviderChain: getAiProviderChainMock,
	isAiConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: enqueueNameSync,
}));
vi.mock("ai", () => ({
	APICallError: { isInstance: () => false },
	generateText: generateTextMock,
}));
vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));
vi.mock("server-only", () => ({}));

function makeSelection(provider: string) {
	return {
		provider,
		modelId: `${provider}-model`,
		model: () => ({}),
		supportsStreaming: true,
		supportsTemperature: true,
		defaultMaxOutputTokens: 8000,
	};
}

function boundaryVtt() {
	const firstCue = `SYNTHETIC section one ${"x".repeat(24_000)}`;
	return `WEBVTT

00:00:07.616 --> 00:33:59.459
${firstCue}

00:34:01.866 --> 00:36:40.000
SYNTHETIC later section

00:36:40.250 --> 00:38:06.998
SYNTHETIC later follow-up
`;
}

function setVideo(metadata: Record<string, unknown>) {
	state.video = {
		id: "video-1",
		ownerId: "user-1",
		orgId: "org-1",
		name: "Original title",
		duration: 2286.998,
		transcriptionStatus: "COMPLETE",
		source: { type: "local" },
		metadata,
	};
}

async function runWorkflow() {
	const { generateAiWorkflow } = await import("@/workflows/generate-ai");
	return generateAiWorkflow({
		videoId: "video-1",
		userId: "user-1",
		generationId: "generation-1",
	});
}

function chunkPrompts(): string[] {
	const prompts = generateTextMock.mock.calls.map(
		(call) => call[0]?.prompt as string,
	);
	return [
		...new Set(
			prompts.filter((prompt) => prompt.includes("Transcript section:")),
		),
	];
}

function displayedOpening(prompt: string) {
	const line = prompt.split("Transcript section:\n")[1]?.split("\n")[0] ?? "";
	const token = line.split("]")[0]?.slice(1) ?? "";
	const seconds = token
		.split(":")
		.reduce((sum, part) => sum * 60 + Number(part), 0);
	return { token, seconds };
}

function sectionBounds(prompt: string) {
	const match = prompt.match(
		/at least ([0-9.]+) and strictly less than ([0-9.]+)/,
	);
	if (!match?.[1] || !match[2]) {
		throw new Error("chunk prompt did not publish exact section bounds");
	}
	return { startTime: Number(match[1]), endTime: Number(match[2]) };
}

function cuesFromPrompt(prompt: string) {
	const section = prompt.split("Transcript section:\n")[1] ?? "";
	return section
		.split("\n")
		.filter((line) => line.startsWith("["))
		.map((line) => {
			const token = line.split("]")[0]?.slice(1) ?? "";
			const start = token
				.split(":")
				.reduce((sum, part) => sum * 60 + Number(part), 0);
			return {
				start,
				text: line.slice(line.indexOf("]") + 1).trim(),
			};
		});
}

function chunkAnalysis(chapters: { title: string; start: number }[]) {
	return JSON.stringify({
		summary: "SYNTHETIC section notes",
		keyPoints: [],
		chapters,
	});
}

function videoDuration(prompt: string) {
	const match = prompt.match(/video that is ([0-9.]+) seconds long/);
	if (!match?.[1]) {
		throw new Error("chunk prompt did not publish video duration");
	}
	return Number(match[1]);
}

function openingRoundtrip(prompt: string) {
	const opening = displayedOpening(prompt);
	const bounds = sectionBounds(prompt);
	let validatorError: string | null = null;
	try {
		validateChapterStartsInSection(
			[{ title: "SYNTHETIC rendered opening", start: opening.seconds }],
			bounds,
			videoDuration(prompt),
			[{ start: bounds.startTime, text: "SYNTHETIC cue" }],
		);
	} catch (error) {
		validatorError = error instanceof Error ? error.message : String(error);
	}
	return {
		token: opening.token,
		seconds: opening.seconds,
		sectionStart: bounds.startTime,
		validatorError,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => {});
	setVideo({ aiGenerationStatus: "QUEUED", aiGenerationId: "generation-1" });
	state.transcript = boundaryVtt();
	state.updateResults = [1, 1];
	state.updates = [];
	state.conditions = [];
	getAiProviderChainMock.mockReturnValue([
		makeSelection("groq"),
		makeSelection("openai"),
	]);
	generateTextMock.mockResolvedValue({ text: "not JSON" });
});

describe("exact cue display", () => {
	it("renders both chunk openings as absolute seconds the section validator accepts", async () => {
		await runWorkflow().catch((error: unknown) => error);

		expect(chunkPrompts().map(openingRoundtrip)).toEqual([
			{
				token: "7.616",
				seconds: 7.616,
				sectionStart: 7.616,
				validatorError: null,
			},
			{
				token: "2041.866",
				seconds: 2041.866,
				sectionStart: 2041.866,
				validatorError: null,
			},
		]);
	});
});

function chunkContract(prompt: string) {
	return {
		nearZero: prompt.includes("near 0"),
		fullVideo: prompt.includes("full video"),
		fullRecording: prompt.includes("full recording"),
		wholeVideoCount: prompt.includes("6-12 chapters"),
		firstMeaningfulCue: prompt.includes("first meaningful cue"),
		displayedStarts: prompt.includes(
			"exact absolute seconds displayed on this section's cues",
		),
		sectionLocalEnd: prompt.includes("inside this section"),
	};
}

describe("section-local chunk instructions", () => {
	it("does not give a later chunk near-zero or full-recording chapter instructions", async () => {
		await runWorkflow().catch((error: unknown) => error);
		const prompts = chunkPrompts();
		const later = prompts[1] ?? "";

		expect({
			...chunkContract(later),
			sectionStart: later.includes("2041.866"),
			sectionCount: later.includes("2-4 chapters"),
		}).toEqual({
			nearZero: false,
			fullVideo: false,
			fullRecording: false,
			wholeVideoCount: false,
			firstMeaningfulCue: true,
			displayedStarts: true,
			sectionLocalEnd: true,
			sectionStart: true,
			sectionCount: true,
		});
		const first = prompts[0] ?? "";
		expect(first).toContain("6-12 chapters");
		expect(first).toContain("first meaningful cue, 7.616 seconds");
		expect(chunkContract(first).nearZero).toBe(false);
		expect(chunkContract(first).fullVideo).toBe(false);
	});

	it("keeps near-zero full-video guidance on the whole-recording prompt", async () => {
		state.transcript = `WEBVTT

00:00:00.000 --> 00:30:01.000
SYNTHETIC whole recording
`;
		await runWorkflow().catch((error: unknown) => error);
		const prompt = generateTextMock.mock.calls[0]?.[0].prompt as string;

		expect(prompt).not.toContain("Transcript section:");
		expect(prompt).toContain("near 0 seconds");
		expect(prompt).toContain("across the full video");
		expect(prompt).toContain("6-12 chapters");
	});
});

function savedPayload() {
	return JSON.stringify(state.updates);
}

function answerFor(prompt: string) {
	if (prompt.includes("Transcript section:") && prompt.includes("[2041.866]")) {
		return {
			text: chunkAnalysis([
				{ title: "SYNTHETIC later phase", start: 2041.866 },
				{ title: "SYNTHETIC later follow-up", start: 2200.25 },
			]),
		};
	}
	if (prompt.includes("Transcript section:")) {
		return {
			text: chunkAnalysis([{ title: "SYNTHETIC opening", start: 7.616 }]),
		};
	}
	if (prompt.includes("creating a concise title")) {
		return { text: '{"title":"SYNTHETIC boundary walkthrough"}' };
	}
	throw new Error(`unexpected SYNTHETIC prompt: ${prompt.slice(0, 80)}`);
}

describe("mocked chapter pipeline", () => {
	it("saves a substantive title and exact-cue chapters without summary or edit writes", async () => {
		setVideo({
			aiGenerationStatus: "QUEUED",
			aiGenerationId: "generation-1",
			summary: "Owner summary",
			summaryManuallyEdited: true,
		});
		state.video = {
			...state.video,
			name: "Cap Recording - 1 October 2026",
		};
		generateTextMock.mockImplementation(async (args: { prompt: string }) =>
			answerFor(args.prompt),
		);

		const result = await runWorkflow();

		expect(result).toEqual({
			success: true,
			message: "AI generation completed successfully",
		});
		expect(savedPayload()).toContain("SYNTHETIC boundary walkthrough");
		expect(savedPayload()).toContain("SYNTHETIC opening");
		expect(savedPayload()).toContain("SYNTHETIC later phase");
		expect(savedPayload()).toContain("7.616");
		expect(savedPayload()).toContain("2041.866");
		expect(savedPayload()).not.toContain("$.summary");
		expect(savedPayload()).not.toContain("Owner summary");
		expect(savedPayload()).not.toContain("video_edits");
		expect(
			state.updates.map((update) => Object.keys(update as object)),
		).toEqual([["metadata"], ["metadata"], ["name"]]);
		expect(enqueueNameSync).toHaveBeenCalledTimes(1);
		expect(
			generateTextMock.mock.calls.some((call) =>
				String(call[0]?.prompt).includes("creating navigation chapters"),
			),
		).toBe(false);
	});

	it("saves chapters but does not replace a manual title", async () => {
		setVideo({
			aiGenerationStatus: "QUEUED",
			aiGenerationId: "generation-1",
			titleManuallyEdited: true,
			summary: "Owner summary",
			summaryManuallyEdited: true,
		});
		state.video = { ...state.video, name: "Owner title" };
		generateTextMock.mockImplementation(async (args: { prompt: string }) =>
			answerFor(args.prompt),
		);

		await runWorkflow();

		expect(savedPayload()).toContain("SYNTHETIC boundary walkthrough");
		expect(savedPayload()).not.toContain("Owner summary");
		expect(savedPayload()).not.toContain("$.summary");
		expect(
			state.updates.some((update) => Object.hasOwn(update as object, "name")),
		).toBe(false);
		expect(enqueueNameSync).not.toHaveBeenCalled();
	});

	it("does not call the provider when the generation claim is already stale", async () => {
		state.updateResults = [0];

		const result = await runWorkflow();

		expect(result).toMatchObject({
			success: true,
			message: "AI generation claim is no longer current",
		});
		expect(generateTextMock).not.toHaveBeenCalled();
	});

	it("does not replace manual chapters or the saved summary", async () => {
		setVideo({
			aiGenerationStatus: "QUEUED",
			aiGenerationId: "generation-1",
			chaptersManuallyEdited: true,
			chapters: [{ title: "Owner chapter", start: 10 }],
			summary: "Owner summary",
			summaryManuallyEdited: true,
		});

		const result = await runWorkflow();

		expect(result).toMatchObject({ success: true });
		expect(generateTextMock).not.toHaveBeenCalled();
		expect(savedPayload()).not.toContain("Owner summary");
		expect(savedPayload()).not.toContain("Owner chapter");
		expect(savedPayload()).toContain("SKIPPED");
	});

	it.each([
		{
			label: "outside",
			chapters: [{ title: "SYNTHETIC outside", start: 2041 }],
			message: "outside its transcript section",
		},
		{
			label: "unsorted",
			chapters: [
				{ title: "SYNTHETIC later", start: 2200.25 },
				{ title: "SYNTHETIC unsorted", start: 2041.866 },
			],
			message: "unsorted chapter timestamps",
		},
		{
			label: "duplicate",
			chapters: [
				{ title: "SYNTHETIC duplicate", start: 2041.866 },
				{ title: "SYNTHETIC duplicate again", start: 2041.866 },
			],
			message: "unsorted chapter timestamps",
		},
		{
			label: "noncue",
			chapters: [{ title: "SYNTHETIC noncue", start: 2100 }],
			message: "does not align with a transcript cue",
		},
	])(
		"rejects $label chunk output instead of saving it",
		async ({ chapters, message }) => {
			generateTextMock.mockResolvedValue({ text: chunkAnalysis(chapters) });

			const result = await runWorkflow().catch((error: unknown) => error);

			expect(result).toBeInstanceOf(Error);
			expect((result as Error).message).toContain("usable chunk");
			expect(savedPayload()).not.toContain(chapters[0]?.title);
			const later = chunkPrompts()[1] ?? "";
			expect(() =>
				validateChapterStartsInSection(
					chapters,
					sectionBounds(later),
					videoDuration(later),
					cuesFromPrompt(later),
				),
			).toThrow(message);
		},
	);

	it("still rejects the floored openings 7 and 2041", async () => {
		await runWorkflow().catch((error: unknown) => error);
		const prompts = chunkPrompts();
		const cases = [
			{ prompt: prompts[0], start: 7 },
			{ prompt: prompts[1], start: 2041 },
		];
		for (const item of cases) {
			expect(() =>
				validateChapterStartsInSection(
					[{ title: "SYNTHETIC floored", start: item.start }],
					sectionBounds(item.prompt ?? ""),
					videoDuration(item.prompt ?? ""),
					cuesFromPrompt(item.prompt ?? ""),
				),
			).toThrow("outside its transcript section");
		}
	});
	it("rejects a too-few synthesis result before saving a title", async () => {
		generateTextMock.mockImplementation(async (args: { prompt: string }) => {
			const prompt = args.prompt;
			if (
				prompt.includes("Transcript section:") &&
				prompt.includes("[2041.866]")
			) {
				return { text: "not JSON" };
			}
			if (prompt.includes("Transcript section:")) {
				return {
					text: chunkAnalysis([{ title: "Overview", start: 7.616 }]),
				};
			}
			if (prompt.includes("creating navigation chapters")) {
				return {
					text: '{"chapters":[{"title":"Overview","start":7.616}]}',
				};
			}
			throw new Error("title call should not run");
		});

		const result = await runWorkflow().catch((error: unknown) => error);

		expect(result).toBeInstanceOf(Error);
		const cause = (result as { cause?: { message?: string } }).cause;
		expect(cause?.message).toContain("useful chapters");
		expect(savedPayload()).not.toContain("SYNTHETIC boundary walkthrough");
		expect(
			generateTextMock.mock.calls.some((call) =>
				String(call[0]?.prompt).includes("creating a concise title"),
			),
		).toBe(false);
	});
});

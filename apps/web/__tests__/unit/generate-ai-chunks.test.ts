import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	video: null as Record<string, unknown> | null,
	transcript: null as string | null,
	updateResults: [] as number[],
	updates: [] as unknown[],
	conditions: [] as unknown[],
}));
const generateTextMock = vi.hoisted(() => vi.fn());
const getAiProviderChainMock = vi.hoisted(() => vi.fn());

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
	enqueueVideoStorageNameSync: vi.fn(),
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

function longCue(character: string, length: number) {
	return character.repeat(length);
}

const LONG_VTT = `WEBVTT

00:00:00.000 --> 00:00:30.000
${longCue("a", 13000)}

00:00:30.000 --> 00:02:00.000
${longCue("b", 11000)}

00:02:00.000 --> 00:30:00.000
${longCue("c", 11000)}`;

function setVideo(metadata: Record<string, unknown>) {
	state.video = {
		id: "video-1",
		ownerId: "user-1",
		orgId: "org-1",
		name: "Original title",
		duration: 1800,
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

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => {});
	setVideo({ aiGenerationStatus: "QUEUED", aiGenerationId: "generation-1" });
	state.transcript = LONG_VTT;
	state.updateResults = [1, 1];
	state.updates = [];
	state.conditions = [];
	getAiProviderChainMock.mockReturnValue([
		makeSelection("groq"),
		makeSelection("openai"),
	]);
});

describe("multi-chunk chapter evidence", () => {
	it("retains timestamped cues and falls back past non-cue chunk and synthesis output", async () => {
		generateTextMock
			.mockResolvedValueOnce({
				text: '{"summary":"First section.","keyPoints":[],"chapters":[{"title":"Wrong chunk time","start":15}]}',
			})
			.mockResolvedValueOnce({
				text: '{"summary":"First section.","keyPoints":[],"chapters":[{"title":"Opening","start":0}]}',
			})
			.mockResolvedValueOnce({
				text: '{"summary":"Later section.","keyPoints":[],"chapters":[{"title":"Later section","start":30}]}',
			})
			.mockResolvedValueOnce({
				text: '{"chapters":[{"title":"Wrong synthesis time","start":60},{"title":"Later section","start":120}]}',
			})
			.mockResolvedValueOnce({
				text: '{"chapters":[{"title":"Opening","start":0},{"title":"Later section","start":120}]}',
			})
			.mockResolvedValueOnce({ text: '{"title":"Long workflow review"}' });

		const result = await runWorkflow();

		expect(result).toEqual({
			success: true,
			message: "AI generation completed successfully",
		});
		expect(generateTextMock).toHaveBeenCalledTimes(6);
		expect(generateTextMock.mock.calls[0]?.[0].prompt).toContain(
			"Transcript section:\n[0] ",
		);
		expect(generateTextMock.mock.calls[1]?.[0].prompt).toContain(
			"Transcript section:\n[0] ",
		);
		expect(generateTextMock.mock.calls[2]?.[0].prompt).toContain(
			"Transcript section:\n[30] ",
		);
		expect(generateTextMock.mock.calls[2]?.[0].prompt).toContain("[120] ");
		expect(generateTextMock.mock.calls[3]?.[0].prompt).toContain(
			"Allowed chapter cue starts (seconds): 0, 30, 120",
		);
		expect(generateTextMock.mock.calls[4]?.[0].prompt).toContain(
			"Allowed chapter cue starts (seconds): 0, 30, 120",
		);
		expect(JSON.stringify(state.updates)).toContain("Long workflow review");
	});

	it("splits a short-text long meeting into time sections so chapters cover the whole video", async () => {
		const cues = Array.from({ length: 32 }, (_, i) => {
			const start = i * 60;
			const ts = (n: number) =>
				`00:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000`;
			return `${ts(start)} --> ${ts(start + 10)}\nTopic talk minute ${i}.`;
		});
		state.transcript = `WEBVTT\n\n${cues.join("\n\n")}`;
		const section = (a: number, b: number) => ({
			text: JSON.stringify({
				summary: "Section.",
				keyPoints: [],
				chapters: [
					{ title: `Topic ${a}`, start: a },
					{ title: `Topic ${b}`, start: b },
				],
			}),
		});
		generateTextMock
			.mockResolvedValueOnce(section(0, 300))
			.mockResolvedValueOnce(section(600, 900))
			.mockResolvedValueOnce(section(1200, 1500))
			.mockResolvedValueOnce({
				text: '{"summary":"End.","keyPoints":[],"chapters":[{"title":"Wrap up","start":1800}]}',
			})
			.mockResolvedValueOnce({ text: '{"title":"Long meeting"}' });

		await runWorkflow();

		expect(generateTextMock.mock.calls[0]?.[0].prompt).toContain("section 1 of 4");
		const saved = JSON.stringify(state.updates);
		expect(saved).toContain("Topic 1500");
		expect(saved).toContain("Wrap up");
	});

	it("fails before title fallback when every chunk analysis is unusable", async () => {
		generateTextMock
			.mockResolvedValueOnce({ text: "not JSON" })
			.mockResolvedValueOnce({ text: "still not JSON" })
			.mockResolvedValueOnce({ text: "not JSON" })
			.mockResolvedValueOnce({ text: "still not JSON" })
			.mockResolvedValueOnce({ text: '{"title":"Fabricated title"}' });

		const result = await runWorkflow().catch((error: unknown) => error);

		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("usable chunk");
		expect(generateTextMock).toHaveBeenCalledTimes(4);
		expect(state.video?.metadata).not.toHaveProperty(
			"aiChapterBackfillGenerationId",
		);
		expect(state.updates).toHaveLength(2);
		const terminalUpdate = state.updates.at(-1) as {
			metadata: { strings: string[]; values: unknown[] };
		};
		expect(terminalUpdate.metadata.strings.join("")).toContain(
			"'$.aiChapterBackfillGenerationId'",
		);
		expect(terminalUpdate.metadata.values.at(-1)).toEqual({
			strings: [
				"JSON_SET(COALESCE(",
				", JSON_OBJECT()), '$.aiGenerationStatus', 'ERROR')",
			],
			values: ["videos.metadata"],
		});
		expect(JSON.stringify(state.updates)).not.toContain("Fabricated title");
	});
});

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

vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/ai/provider", () => ({
	isAiConfigured: () => true,
}));
vi.mock("@/lib/ai/run", () => ({
	AiUnavailableError: class AiUnavailableError extends Error {},
	runWithAiProviders: async (
		_kind: string,
		run: (selection: unknown) => Promise<unknown>,
	) =>
		run({
			model: () => ({}),
			defaultMaxOutputTokens: 8000,
		}),
}));
vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: vi.fn(),
}));
vi.mock("ai", () => ({
	generateText: generateTextMock,
}));
vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));
vi.mock("server-only", () => ({}));

const SHORT_VTT = `WEBVTT

00:00:00.000 --> 00:00:05.000
This is a useful transcript.`;

function setVideo(metadata: Record<string, unknown>) {
	state.video = {
		id: "video-1",
		ownerId: "user-1",
		orgId: "org-1",
		name: "Original title",
		duration: 5,
		transcriptionStatus: "COMPLETE",
		source: { type: "local" },
		metadata,
	};
}

function prepare({
	metadata,
	transcript,
	claimResult,
}: {
	metadata: Record<string, unknown>;
	transcript: string | null;
	claimResult: number;
}) {
	setVideo(metadata);
	state.transcript = transcript;
	state.updateResults = [claimResult];
	state.updates = [];
	state.conditions = [];
	generateTextMock.mockReset();
	generateTextMock.mockResolvedValue({
		text: '{"title":"Current title","chapters":[{"title":"Opening","start":0}]}',
	});
}

async function runWorkflow(generationId: string) {
	const { generateAiWorkflow } = await import("@/workflows/generate-ai");
	return generateAiWorkflow({
		videoId: "video-1",
		userId: "user-1",
		generationId,
	});
}

describe("AI generation claim fencing", () => {
	beforeEach(() => {
		prepare({
			metadata: { aiGenerationStatus: "QUEUED", aiGenerationId: "current" },
			transcript: SHORT_VTT,
			claimResult: 1,
		});
	});

	it.each([
		["COMPLETE", SHORT_VTT],
		["ERROR", SHORT_VTT],
		["SKIPPED", null],
	] as const)(
		"old run cannot write %s after reset",
		async (terminal, transcript) => {
			prepare({ metadata: {}, transcript, claimResult: 0 });
			if (terminal === "ERROR") {
				generateTextMock.mockRejectedValueOnce(new Error("provider failed"));
			}

			const result =
				terminal === "ERROR"
					? await runWorkflow("old-generation").catch((error) => error)
					: await runWorkflow("old-generation");

			expect(result).not.toBeInstanceOf(Error);
			expect(state.updates).toHaveLength(0);
			expect(JSON.stringify(state.updates)).not.toContain(`'${terminal}'`);
		},
	);

	it("old run cannot overwrite a newer run token", async () => {
		prepare({
			metadata: {
				aiGenerationStatus: "QUEUED",
				aiGenerationId: "new-generation",
			},
			transcript: SHORT_VTT,
			claimResult: 0,
		});

		const result = await runWorkflow("old-generation");

		expect(result).toMatchObject({ success: true });
		expect(state.updates).toHaveLength(0);
		expect(JSON.stringify(state.updates)).not.toContain("COMPLETE");
		expect(state.video?.metadata).toMatchObject({
			aiGenerationId: "new-generation",
		});
	});

	it("current run can complete with its claimed token", async () => {
		prepare({
			metadata: {
				aiGenerationStatus: "QUEUED",
				aiGenerationId: "current-generation",
			},
			transcript: SHORT_VTT,
			claimResult: 1,
		});

		const result = await runWorkflow("current-generation");

		expect(result).toEqual({
			success: true,
			message: "AI generation completed successfully",
		});
		expect(JSON.stringify(state.conditions[0])).toContain("current-generation");
		expect(state.updates).toHaveLength(2);
		expect(JSON.stringify(state.updates[1])).toContain("COMPLETE");
	});

	it("a matching legacy backfill marker bypasses the valid old chapter and is cleared on completion", async () => {
		prepare({
			metadata: {
				aiGenerationStatus: "QUEUED",
				aiGenerationId: "backfill-generation",
				aiChapterBackfillGenerationId: "backfill-generation",
				chapters: [{ title: "Legacy only chapter", start: 0 }],
			},
			transcript: SHORT_VTT,
			claimResult: 1,
		});
		state.video = { ...state.video, duration: 1972.9 };

		const result = await runWorkflow("backfill-generation");

		expect(result.message).toBe("AI generation completed successfully");
		expect(state.updates).toHaveLength(2);
		expect(JSON.stringify(state.updates[0])).toContain("PROCESSING");
		expect(JSON.stringify(state.updates[0])).not.toContain("$.chapters");
		expect(JSON.stringify(state.updates[0])).not.toContain(
			"Legacy only chapter",
		);
		expect(JSON.stringify(state.updates[1])).toContain("JSON_REMOVE");
		expect(JSON.stringify(state.updates[1])).toContain(
			"$.aiChapterBackfillGenerationId",
		);
		expect(JSON.stringify(state.updates[1])).not.toContain(
			"Legacy only chapter",
		);
		expect(JSON.stringify(state.updates[1])).not.toContain("$.summary");
	});

	it("does not process when a matching marker becomes stale before the processing claim", async () => {
		prepare({
			metadata: {
				aiGenerationStatus: "QUEUED",
				aiGenerationId: "backfill-generation",
				aiChapterBackfillGenerationId: "backfill-generation",
				chapters: [{ title: "Legacy only chapter", start: 0 }],
			},
			transcript: SHORT_VTT,
			claimResult: 0,
		});
		state.video = { ...state.video, duration: 1972.9 };

		const result = await runWorkflow("backfill-generation");

		expect(result).toMatchObject({ success: true });
		expect(generateTextMock).not.toHaveBeenCalled();
		expect(state.updates).toHaveLength(2);
		expect(JSON.stringify(state.conditions[0])).toContain(
			"$.aiChapterBackfillGenerationId",
		);
		expect(JSON.stringify(state.updates[1])).toContain("SKIPPED");
		expect(JSON.stringify(state.updates[1])).toContain(
			"$.aiChapterBackfillGenerationId",
		);
	});

	it("a valid chapter with a mismatched marker is skipped without clearing another generation's marker", async () => {
		prepare({
			metadata: {
				aiGenerationStatus: "QUEUED",
				aiGenerationId: "current-generation",
				aiChapterBackfillGenerationId: "older-generation",
				chapters: [{ title: "Modern coherent chapter", start: 0 }],
			},
			transcript: SHORT_VTT,
			claimResult: 1,
		});

		const result = await runWorkflow("current-generation");

		expect(result).toMatchObject({ success: true });
		expect(generateTextMock).not.toHaveBeenCalled();
		expect(state.updates).toHaveLength(1);
		expect(JSON.stringify(state.updates[0])).toContain("SKIPPED");
		expect(JSON.stringify(state.updates[0])).toContain("IF");
		expect(JSON.stringify(state.updates[0])).toContain("current-generation");
		expect(JSON.stringify(state.updates[0])).toContain(
			"$.aiChapterBackfillGenerationId",
		);
	});

	it.each([
		["SKIPPED", null],
		["ERROR", SHORT_VTT],
	] as const)(
		"restores retryable legacy provenance when a backfill reaches %s",
		async (terminal, transcript) => {
			prepare({
				metadata: {
					aiGenerationStatus: "QUEUED",
					aiGenerationId: "backfill-generation",
					aiChapterBackfillGenerationId: "backfill-generation",
				},
				transcript,
				claimResult: 1,
			});
			if (terminal === "ERROR") {
				generateTextMock.mockRejectedValueOnce(new Error("provider failed"));
			}

			const result = await runWorkflow("backfill-generation").catch(
				(error) => error,
			);

			if (terminal === "ERROR") expect(result).toBeInstanceOf(Error);
			expect(JSON.stringify(state.updates.at(-1))).toContain(terminal);
			expect(JSON.stringify(state.updates.at(-1))).toContain("JSON_REMOVE");
			expect(JSON.stringify(state.updates.at(-1))).toContain(
				"$.aiChapterBackfillGenerationId",
			);
			expect(JSON.stringify(state.updates.at(-1))).toContain(
				"$.aiGenerationId",
			);
			expect(JSON.stringify(state.updates.at(-1))).toContain("COMPLETE");
		},
	);

	it("persists the deterministic clamp result for cue-aligned single-chunk near duplicates", async () => {
		prepare({
			metadata: {
				aiGenerationStatus: "QUEUED",
				aiGenerationId: "current-generation",
			},
			transcript: SHORT_VTT,
			claimResult: 1,
		});
		generateTextMock.mockResolvedValueOnce({
			text: '{"title":"Current title","chapters":[{"title":"Opening","start":0},{"title":"Near duplicate","start":0.5}]}',
		});

		const result = await runWorkflow("current-generation");

		expect(result).toMatchObject({ success: true });
		expect(JSON.stringify(state.updates[1])).toContain("Opening");
		expect(JSON.stringify(state.updates[1])).not.toContain("Near duplicate");
	});
});

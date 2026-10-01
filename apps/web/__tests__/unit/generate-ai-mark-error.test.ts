import { organizations, videos } from "@cap/database/schema";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	afterClaim: undefined as undefined | (() => void),
	flipTranscription: false,
	video: null as Record<string, unknown> | null,
}));

vi.mock("server-only", () => ({}));

vi.mock("drizzle-orm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm")>();
	const expression = (op: string, args: unknown[]) => ({ op, args });
	const sql = Object.assign(
		(strings: TemplateStringsArray, ...values: unknown[]) =>
			expression("sql", [strings, ...values]),
		actual.sql,
	);
	return {
		...actual,
		and: (...args: unknown[]) =>
			expression(
				"and",
				args.filter((item) => item !== undefined),
			),
		eq: (left: unknown, right: unknown) => expression("eq", [left, right]),
		sql,
	};
});

vi.mock("@cap/database", () => ({
	db: () => database,
}));

vi.mock("@cap/env", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/env")>();
	return { ...actual, serverEnv: () => ({}) };
});

vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					getObject: () => Effect.fail(new Error("transcript unavailable")),
				},
			]),
	},
}));

vi.mock("@/lib/ai/provider", () => ({
	isAiConfigured: () => true,
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));

vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: (effect: Effect.Effect<unknown>) =>
		Effect.runPromise(effect),
}));

vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: vi.fn(),
}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));

vi.mock("ai", () => ({
	APICallError: { isInstance: () => false },
	generateText: vi.fn(),
}));

import { generateAiWorkflow } from "@/workflows/generate-ai";

type Expression = { op: string; args: unknown[] };

function isExpression(value: unknown): value is Expression {
	return (
		typeof value === "object" &&
		value !== null &&
		"op" in value &&
		"args" in value
	);
}

function columnKey(operand: unknown) {
	for (const table of [videos, organizations]) {
		for (const [key, column] of Object.entries(table)) {
			if (column === operand) return key;
		}
	}
	return undefined;
}

function sqlText(expression: Expression) {
	const strings = expression.args[0];
	return Array.isArray(strings) ? strings.join(" ") : String(strings);
}

function stringValue(expression: Expression) {
	return expression.args.find((value) => typeof value === "string");
}

function sqlExpected(expression: Expression) {
	const text = sqlText(expression);
	const literal = text.match(/=\s*'([^']+)'\s*$/);
	if (literal) return literal[1];
	return stringValue(expression);
}

function sqlMatches(row: Record<string, unknown>, expression: Expression) {
	const text = sqlText(expression);
	const metadata = (row.metadata ?? {}) as Record<string, unknown>;
	const expected = sqlExpected(expression);
	if (text.includes("$.aiGenerationId"))
		return metadata.aiGenerationId === expected;
	if (text.includes("$.aiGenerationStatus"))
		return metadata.aiGenerationStatus === expected;
	if (text.includes("$.aiChapterBackfillGenerationId"))
		return metadata.aiChapterBackfillGenerationId === expected;
	return true;
}

function evaluate(row: Record<string, unknown>, condition: unknown): boolean {
	if (!isExpression(condition)) return true;
	if (condition.op === "and")
		return condition.args.every((item) => evaluate(row, item));
	if (condition.op === "sql") return sqlMatches(row, condition);
	const key = columnKey(condition.args[0]);
	const left = key ? row[key] : condition.args[0];
	if (condition.op === "eq") return left === condition.args[1];
	throw new Error(`Unsupported expression ${condition.op}`);
}

function applyMetadata(row: Record<string, unknown>, expression: Expression) {
	const text = sqlText(expression);
	const metadata = {
		...((row.metadata ?? {}) as Record<string, unknown>),
	};
	const generationId = stringValue(expression);
	const nested = expression.args.find(
		(value): value is Expression => isExpression(value) && value.op === "sql",
	);
	if (
		text.includes("$.aiChapterBackfillGenerationId") &&
		text.includes("COMPLETE")
	) {
		if (metadata.aiChapterBackfillGenerationId === generationId) {
			metadata.aiGenerationStatus = "COMPLETE";
			delete metadata.aiChapterBackfillGenerationId;
			delete metadata.aiGenerationId;
			return metadata;
		}
		if (nested) return applyMetadata(row, nested);
	}
	if (text.includes("$.aiTitle") && nested) return applyMetadata(row, nested);
	if (text.includes("PROCESSING")) metadata.aiGenerationStatus = "PROCESSING";
	if (text.includes("ERROR")) metadata.aiGenerationStatus = "ERROR";
	if (text.includes("SKIPPED")) metadata.aiGenerationStatus = "SKIPPED";
	return metadata;
}

const database = {
	select: () => {
		let joined = false;
		const chain = {
			from: () => chain,
			leftJoin: () => {
				joined = true;
				return chain;
			},
			where: async () =>
				joined && state.video
					? [{ video: state.video, orgSettings: null }]
					: state.video
						? [state.video]
						: [],
		};
		return chain;
	},
	update: () => ({
		set: (changes: Record<string, unknown>) => ({
			where: async (condition: unknown) => {
				const row = state.video;
				if (!row || !evaluate(row, condition)) return [{ affectedRows: 0 }];
				if (isExpression(changes.metadata)) {
					row.metadata = applyMetadata(row, changes.metadata);
				}
				const rest = { ...changes };
				delete rest.metadata;
				Object.assign(row, rest);
				if (
					state.flipTranscription &&
					(row.metadata as Record<string, unknown>).aiGenerationStatus ===
						"PROCESSING"
				) {
					row.transcriptionStatus = "PROCESSING";
					state.afterClaim?.();
				}
				return [{ affectedRows: 1 }];
			},
		}),
	}),
};

function video(metadata: Record<string, unknown>) {
	state.video = {
		id: "video-1",
		ownerId: "owner-1",
		orgId: null,
		name: "Original title",
		duration: 120,
		transcriptionStatus: "COMPLETE",
		source: { type: "webMP4" },
		metadata: {
			summary: "Owner edited summary",
			chapters: [{ title: "Kept", start: 500 }],
			title: "Manual title",
			...metadata,
		},
	};
}

async function failGeneration() {
	return generateAiWorkflow({
		videoId: "video-1",
		userId: "owner-1",
		generationId: "generation-1",
	});
}

describe("AI markError while transcription is processing", () => {
	beforeEach(() => {
		state.afterClaim = undefined;
		state.flipTranscription = false;
		video({
			aiGenerationId: "generation-1",
			aiGenerationStatus: "QUEUED",
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("writes ERROR for the matching generation without requiring transcription COMPLETE", async () => {
		state.flipTranscription = true;

		await expect(failGeneration()).rejects.toThrow("transcript unavailable");

		expect(state.video?.transcriptionStatus).toBe("PROCESSING");
		expect(state.video?.metadata).toMatchObject({
			aiGenerationStatus: "ERROR",
			summary: "Owner edited summary",
			title: "Manual title",
			chapters: [{ title: "Kept", start: 500 }],
		});
	});

	it("does not write when the generation or expected status does not match", async () => {
		state.flipTranscription = true;
		state.afterClaim = () => {
			const metadata = state.video?.metadata as Record<string, unknown>;
			metadata.aiGenerationId = "newer-generation";
		};

		await expect(failGeneration()).rejects.toThrow("transcript unavailable");

		const metadata = state.video?.metadata as Record<string, unknown>;
		expect(metadata.aiGenerationStatus).toBe("PROCESSING");
		expect(metadata.summary).toBe("Owner edited summary");

		video({
			aiGenerationId: "generation-1",
			aiGenerationStatus: "QUEUED",
		});
		state.afterClaim = () => {
			const current = state.video?.metadata as Record<string, unknown>;
			current.aiGenerationStatus = "QUEUED";
		};

		await expect(failGeneration()).rejects.toThrow("transcript unavailable");
		expect(
			(state.video?.metadata as Record<string, unknown>).aiGenerationStatus,
		).toBe("QUEUED");
		expect(state.video?.metadata).toMatchObject({
			summary: "Owner edited summary",
			title: "Manual title",
		});
	});

	it("restores a matching backfill instead of leaving ERROR", async () => {
		state.flipTranscription = true;
		const metadata = state.video?.metadata as Record<string, unknown>;
		metadata.aiChapterBackfillGenerationId = "generation-1";

		await expect(failGeneration()).rejects.toThrow("transcript unavailable");

		const current = state.video?.metadata as Record<string, unknown>;
		expect(current).toMatchObject({
			aiGenerationStatus: "COMPLETE",
			summary: "Owner edited summary",
		});
		expect(current.aiChapterBackfillGenerationId).toBeUndefined();
		expect(current.aiGenerationId).toBeUndefined();
	});
});

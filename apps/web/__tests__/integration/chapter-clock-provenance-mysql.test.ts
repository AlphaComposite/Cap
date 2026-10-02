import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { videos } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { Effect, Option } from "effect";
import mysql from "mysql2/promise";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
}));
vi.mock("@/lib/ai/provider", () => ({
	isAiConfigured: () => true,
}));
vi.mock("@/lib/ai/run", () => ({
	runWithAiProviders: async (
		_operation: string,
		run: (selection: {
			model: () => object;
			defaultMaxOutputTokens: number;
		}) => Promise<unknown>,
	) =>
		run({
			model: () => ({}),
			defaultMaxOutputTokens: 8000,
		}),
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: (effect: Effect.Effect<unknown>) =>
		Effect.runPromise(effect),
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: vi.fn(),
}));
vi.mock("ai", () => ({
	APICallError: { isInstance: () => false },
	generateText: vi.fn(async () => ({
		text: JSON.stringify({
			title: "Generated title",
			chapters: [{ title: "Kept", start: 0 }],
		}),
	})),
}));

const TRANSCRIPT = `WEBVTT

00:00:00.000 --> 00:00:08.000
Opening words about the work.
`;

vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					getObject: () => Effect.succeed(Option.some(TRANSCRIPT)),
				},
			]),
	},
}));

import { db } from "@cap/database";
import {
	aiChapterSaveProbe,
	generateAiWorkflow,
} from "@/workflows/generate-ai";

function regressionUrl() {
	const text = readFileSync(
		"/path/to/scratch/cap-fzp-8-wire/correct-upload-baseline57/parent-test.env",
		"utf8",
	);
	const values: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("export ") || !line.includes("=")) continue;
		const eqAt = line.indexOf("=");
		const key = line.slice(7, eqAt);
		let value = line
			.slice(eqAt + 1)
			.trim()
			.replace(/^"|"$/g, "");
		for (const [existing, substitution] of Object.entries(values)) {
			value = value.replace(`$${existing}`, substitution);
		}
		values[key] = value;
	}
	const base = values.CAP_SOURCE_PREPARE_MYSQL ?? "";
	const query = base.indexOf("?");
	const dbPath = query === -1 ? base : base.slice(0, query);
	const suffix = "/cap57_test_basic";
	if (!dbPath.endsWith(suffix)) {
		throw new Error("refusing source database other than cap57_test_basic");
	}
	const url = `${dbPath.slice(0, -suffix.length)}/cap57_test_regression${query === -1 ? "" : base.slice(query)}`;
	const match = url.match(
		/^mysql:\/\/(?:[^@/]+)@([^:/]+)(?::(\d+))?\/([^?/\s]+)/,
	);
	if (!match) throw new Error("refusing unparseable disposable database url");
	const host = match[1];
	const database = match[3];
	if (host !== "127.0.0.1" && host !== "localhost") {
		throw new Error(`refusing non-local database host ${host}`);
	}
	if (database !== "cap57_test_regression") {
		throw new Error(`refusing database ${database}`);
	}
	return url;
}

const databaseUrl = regressionUrl();
process.env.DATABASE_URL = databaseUrl;
process.env.CAP_INSTANT_FINISH_OWNERS = "";

const ownerId = "clkf2owner00001";
const orgId = "clkf2org0000001";
const videoId = "clkf2video00001";
const siblingId = "clkf2video00002";
const migrationsFolder = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../packages/database/migrations",
);

type Metadata = {
	summary?: string;
	chapters?: { title: string; start: number }[];
	sourceChapters?: { title: string; start: number }[];
	chaptersRevisionId?: string;
	chaptersManuallyEdited?: boolean;
	titleManuallyEdited?: boolean;
	aiGenerationStatus?:
		| "QUEUED"
		| "PROCESSING"
		| "COMPLETE"
		| "ERROR"
		| "SKIPPED";
	aiGenerationId?: string;
	aiChapterBackfillGenerationId?: string;
};

describe("chapter clock provenance on disposable MySQL", () => {
	let pool: mysql.Pool;

	beforeAll(async () => {
		const parsed = new URL(databaseUrl);
		if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
			throw new Error("refusing non-local database host");
		}
		if (parsed.pathname !== "/cap57_test_regression") {
			throw new Error("refusing database other than cap57_test_regression");
		}
		pool = mysql.createPool(databaseUrl);
		await migrate(drizzle(pool), { migrationsFolder });
		await cleanup();
	}, 180_000);

	afterEach(() => {
		aiChapterSaveProbe.afterEarlyRead = undefined;
	});

	afterAll(async () => {
		aiChapterSaveProbe.afterEarlyRead = undefined;
		if (pool) {
			await cleanup();
			await pool.end();
		}
	});

	async function cleanup() {
		await pool.query("DELETE FROM video_publication WHERE videoId IN (?, ?)", [
			videoId,
			siblingId,
		]);
		await pool.query("DELETE FROM videos WHERE id IN (?, ?)", [
			videoId,
			siblingId,
		]);
	}

	async function seed(metadata: Metadata) {
		await cleanup();
		await db()
			.insert(videos)
			.values({
				id: videoId as never,
				ownerId: ownerId as never,
				orgId: orgId as never,
				name: "Manual title",
				source: { type: "webMP4" },
				duration: 120,
				transcriptionStatus: "COMPLETE",
				metadata: {
					summary: "Saved summary",
					titleManuallyEdited: true,
					aiGenerationStatus: "QUEUED",
					aiGenerationId: "generation-1",
					...metadata,
				},
			});
		await db()
			.insert(videos)
			.values({
				id: siblingId as never,
				ownerId: ownerId as never,
				orgId: orgId as never,
				name: "Sibling",
				source: { type: "webMP4" },
				duration: 30,
				transcriptionStatus: "COMPLETE",
				metadata: {
					summary: "Sibling summary",
					chapters: [{ title: "Sibling chapter", start: 1 }],
					sourceChapters: [{ title: "Sibling source", start: 2 }],
					chaptersRevisionId: "sibling-revision",
				},
			});
	}

	async function read(id: string) {
		const [row] = await db()
			.select({ metadata: videos.metadata, name: videos.name })
			.from(videos)
			.where(eq(videos.id, id as never));
		return row;
	}

	it("clears provenance when a nonmanual writer changes titles after the early read", async () => {
		await seed({
			chapters: [{ title: "Kept", start: 0 }],
			sourceChapters: [{ title: "Kept", start: 0 }],
			chaptersRevisionId: "rev-kept",
			aiChapterBackfillGenerationId: "generation-1",
		});
		aiChapterSaveProbe.afterEarlyRead = async () => {
			await pool.query(
				"UPDATE videos SET metadata = JSON_SET(metadata, '$.chapters', CAST(? AS JSON), '$.sourceChapters', CAST(? AS JSON), '$.chaptersRevisionId', ?) WHERE id = ?",
				[
					JSON.stringify([{ title: "Writer", start: 0 }]),
					JSON.stringify([{ title: "Writer source", start: 9 }]),
					"writer-revision",
					videoId,
				],
			);
		};

		const result = await generateAiWorkflow({
			videoId,
			userId: ownerId,
			generationId: "generation-1",
		});

		expect(result).toEqual({
			success: true,
			message: "AI generation completed successfully",
		});
		const row = await read(videoId);
		expect(row?.metadata?.chapters).toEqual([{ title: "Kept", start: 0 }]);
		expect(row?.metadata?.sourceChapters).toBeUndefined();
		expect(row?.metadata?.chaptersRevisionId).toBeUndefined();
		expect(row?.metadata?.summary).toBe("Saved summary");
		expect(row?.name).toBe("Manual title");
		expect(await read(siblingId)).toMatchObject({
			name: "Sibling",
			metadata: {
				summary: "Sibling summary",
				chapters: [{ title: "Sibling chapter", start: 1 }],
				sourceChapters: [{ title: "Sibling source", start: 2 }],
				chaptersRevisionId: "sibling-revision",
			},
		});
	});

	it("keeps owner chapter fields when the manual flag lands before the locked commit", async () => {
		await seed({
			chapters: [{ title: "Old", start: 0 }],
			sourceChapters: [{ title: "Old canonical", start: 7 }],
			chaptersRevisionId: "rev-old",
			aiChapterBackfillGenerationId: "generation-1",
		});
		aiChapterSaveProbe.afterEarlyRead = async () => {
			await pool.query(
				"UPDATE videos SET metadata = JSON_SET(metadata, '$.chaptersManuallyEdited', CAST('true' AS JSON), '$.chapters', CAST(? AS JSON), '$.sourceChapters', CAST(? AS JSON), '$.chaptersRevisionId', ?) WHERE id = ?",
				[
					JSON.stringify([{ title: "Owner chapter", start: 4 }]),
					JSON.stringify([{ title: "Owner source", start: 12 }]),
					"owner-revision",
					videoId,
				],
			);
		};

		const result = await generateAiWorkflow({
			videoId,
			userId: ownerId,
			generationId: "generation-1",
		});

		expect(result.message).toBe("AI generation completed successfully");
		const row = await read(videoId);
		expect(row?.metadata).toMatchObject({
			chaptersManuallyEdited: true,
			chapters: [{ title: "Owner chapter", start: 4 }],
			sourceChapters: [{ title: "Owner source", start: 12 }],
			chaptersRevisionId: "owner-revision",
			summary: "Saved summary",
			aiGenerationStatus: "COMPLETE",
		});
	});
});

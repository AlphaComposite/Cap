import { editRevision, videoPublication, videos } from "@cap/database/schema";
import type { VideoEditSpecV2 } from "@cap/database/types";
import { defaultAutoCuts } from "@cap/web-backend/src/identity-edit-spec";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as chapterSource from "@/lib/revision-chapter-source";
import { getEditSpecOutputDuration } from "@/lib/video-edits";
import * as generation from "@/workflows/generate-ai";
import * as workflow from "@/workflows/regenerate-revision-chapters";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	configured: vi.fn(() => true),
	ai: vi.fn(),
	sleep: vi.fn(),
	load: vi.fn(),
	start: vi.fn(),
	publish: vi.fn(),
	record: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("ai", () => ({ generateText: mocks.ai }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("workflow", () => ({
	sleep: mocks.sleep,
	FatalError: class extends Error {},
}));
vi.mock("@/lib/ai/provider", () => ({ isAiConfigured: mocks.configured }));
vi.mock("@/lib/ai/run", () => ({
	runWithAiProviders: async (
		_: unknown,
		run: (selection: unknown) => unknown,
	) => run({ model: () => ({}), defaultMaxOutputTokens: 8000 }),
}));
vi.mock("@/lib/revision-publication", () => ({
	loadStoredEditTranscript: mocks.load,
	publishInstantFinishRevision: mocks.publish,
	recordServerDraft: mocks.record,
	RevisionPublicationError: class extends Error {},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "owner" }),
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/instant-finish-flag", () => ({
	isInstantFinishEnabledForOwner: () => true,
}));
vi.mock("@/lib/revision-publication-origin", () => ({
	httpOriginClient: () => ({}),
}));
vi.mock("@/lib/revision-publication-read", () => ({
	getInstantFinishPublicationDto: async () => ({ currentRevisionId: null }),
}));
vi.mock("@/lib/revision-media-grant", () => ({
	mintRevisionMediaGrant: vi.fn(),
}));
vi.mock("@/lib/share-web-url", () => ({
	resolveShareWebUrl: async () => "http://localhost:3000",
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({ Storage: {} }));
vi.mock("@/lib/video-storage", () => ({ decodeStorageVideo: vi.fn() }));
vi.mock("@/lib/workflow-runtime", () => ({ runWorkflowPromise: vi.fn() }));
vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: vi.fn(),
}));

type Chapter = { title: string; start: number };
let spec: VideoEditSpecV2;
let currentRevisionId: string;
let manual: boolean;
let vtt: string;
let chapters: Chapter[];
let sourceChapters: Chapter[];
let writes: Array<{ table: unknown; query: string; params: unknown[] }>;
let locks: unknown[];
let markerWrites: Array<{ query: string; params: unknown[]; guard: string }>;
let saved: {
	chapters?: Chapter[];
	sourceChapters?: Chapter[];
	chaptersRevisionId?: string;
};
const payload = { videoId: "tytbje3dveajrme", revisionId: "revision-6" };
const dialect = new MySqlDialect();
const makeSpec = (
	duration: number,
	ranges: Array<{ start: number; end: number }>,
): VideoEditSpecV2 => ({
	version: 2,
	sourceDuration: duration,
	keepRanges: ranges,
	manualKeepRanges: ranges,
	autoCuts: defaultAutoCuts(),
});
const duration = () => getEditSpecOutputDuration(spec);
const cue = (seconds: number, text: string) => {
	const time = (s: number) =>
		new Date(Math.round(s * 1000)).toISOString().slice(11, 23);
	return `${time(seconds)} --> ${time(seconds + 5)}\n${text}\n`;
};
const metadata = () => ({
	chapters,
	sourceChapters,
	chaptersRevisionId: payload.revisionId,
	chaptersManuallyEdited: manual,
	summary: "Owner pasted this",
	aiTitle: "Leave title alone",
});
const snapshot = () => ({
	captionsVtt: vtt,
	chapters,
	durationSeconds: duration(),
	summaryText: "Owner pasted this",
});
function select(locked = false) {
	let table: unknown;
	const query = {
		from: (value: unknown) => {
			table = value;
			return query;
		},
		leftJoin: () => query,
		innerJoin: () => query,
		where: () => {
			const rows = () =>
				locked
					? table === videos
						? [{ metadata: metadata() }]
						: [{ currentRevisionId }]
					: table === videos
						? [
								{
									video: { metadata: metadata() },
									settings: { aiGenerationLanguage: "auto" },
								},
							]
						: table === editRevision
							? [{ snapshot: snapshot() }]
							: currentRevisionId === payload.revisionId
								? [
										{
											revision: {
												revisionId: currentRevisionId,
												state: "CURRENT",
												metadataSnapshot: snapshot(),
											},
											spec,
										},
									]
								: [];
			return Object.assign(Promise.resolve(rows()), {
				for: async () => {
					locks.push(table);
					return rows();
				},
			});
		},
	};
	return query;
}
const tx = {
	select: () => select(true),
	update: (table: unknown) => ({
		set: (value: { metadata?: never; metadataSnapshot?: never }) => ({
			where: async (condition: never) => {
				const query = dialect.sqlToQuery(
					value.metadata ?? value.metadataSnapshot!,
				);
				if (!query.sql.includes("'$.chapters'")) {
					markerWrites.push({
						query: query.sql,
						params: query.params,
						guard: dialect.sqlToQuery(condition).sql,
					});
					return [{ affectedRows: 1 }];
				}
				writes.push({ table, query: query.sql, params: query.params });
				if (table === videos) {
					const arrays = query.params.filter(
						(p): p is string => typeof p === "string" && p.startsWith("["),
					);
					saved = {
						chapters: JSON.parse(arrays[0]!),
						sourceChapters: JSON.parse(arrays[1]!),
						chaptersRevisionId: payload.revisionId,
					};
				}
				return [{ affectedRows: 1 }];
			},
		}),
	}),
};
beforeEach(() => {
	spec = makeSpec(600, [
		{ start: 100, end: 200 },
		{ start: 300, end: 500 },
	]);
	currentRevisionId = payload.revisionId;
	manual = false;
	locks = [];
	writes = [];
	markerWrites = [];
	mocks.configured.mockReturnValue(true);
	saved = {};
	chapters = [{ title: "Old projected chapter", start: 0 }];
	sourceChapters = [];
	vtt = `WEBVTT\n\n${cue(0, "We review website changes and the launch plan.")}\n${cue(100, "Next we decide the Airtable migration and Android release.")}\n${cue(200, "Finally the Apple enrollment needs a DUNS number.")}`;
	mocks.db.mockReturnValue({
		update: tx.update,
		select: () => select(),
		transaction: async (run: (value: typeof tx) => unknown) => run(tx),
	});
	mocks.ai.mockResolvedValue({
		text: JSON.stringify({
			chapters: [
				{ title: "Website", start: 0 },
				{ title: "Airtable and Android", start: 100 },
				{ title: "Apple and DUNS", start: 200 },
			],
		}),
	});
	mocks.load.mockResolvedValue(null);
});

describe("published edit chapter regeneration", () => {
	it("stores the exact source projection for A@0/B@6/C@20 on an 80-second cut", async () => {
		spec = makeSpec(100, [{ start: 0, end: 80 }]);
		vtt = `WEBVTT\n\n${cue(0, "Opening discussion.")}\n${cue(6, "Second topic.")}\n${cue(20, "Last topic.")}`;
		mocks.ai.mockResolvedValue({
			text: JSON.stringify({
				chapters: [
					{ title: "A", start: 0 },
					{ title: "B", start: 6 },
					{ title: "C", start: 20 },
				],
			}),
		});
		expect(await workflow.regenerateRevisionChapters(payload)).toBe(true);
		expect(saved.chapters).toEqual(
			chapterSource.projectSourceChapters(saved.sourceChapters!, spec),
		);
		expect(saved.chapters).toEqual([
			{ title: "B", start: 0 },
			{ title: "C", start: 20 },
		]);
		expect(writes.find((w) => w.table === editRevision)?.params).toContain(
			JSON.stringify(saved.chapters),
		);
		expect(writes.find((w) => w.table === videos)?.query).toContain(
			"$.chaptersRegeneratedRevisionId",
		);
	});

	it("keeps projected old chapters if generated source projects to empty", async () => {
		spec = makeSpec(100, [{ start: 0, end: 5 }]);
		vtt = `WEBVTT\n\n${cue(0, "Opening discussion.")}`;
		mocks.ai.mockResolvedValue({
			text: '{"chapters":[{"title":"A","start":0}]}',
		});
		const projection = vi
			.spyOn(chapterSource, "projectSourceChapters")
			.mockReturnValueOnce([]);
		expect(await workflow.regenerateRevisionChapters(payload)).toBe(false);
		projection.mockRestore();
		expect(writes).toEqual([]);
	});

	it.each(["written", "stale", "manual", "failure", "unconfigured"])(
		"clears only its own pending marker on terminal path: %s",
		async (path) => {
			if (path === "stale") currentRevisionId = "newer";
			if (path === "manual") manual = true;
			if (path === "failure")
				mocks.ai.mockRejectedValue(new Error("AI unavailable"));
			if (path === "unconfigured") mocks.configured.mockReturnValue(false);
			await workflow.regenerateRevisionChapters(payload);
			const clear = markerWrites.find((w) => w.query.includes("JSON_REMOVE"));
			expect(clear?.query).toContain("$.chaptersRegenerationRevisionId");
			expect(clear?.query).toContain("$.chaptersRegenerationQueuedAt");
			expect(clear?.guard).toContain("$.chaptersRegenerationRevisionId");
		},
	);

	it("catches configuration failures and marks pending before queue start", async () => {
		const { startRevisionChapterGeneration } = await import(
			"@/lib/generate-ai"
		);
		mocks.configured.mockImplementationOnce(() => {
			throw new Error("configuration failed");
		});
		await expect(
			startRevisionChapterGeneration(payload.videoId, payload.revisionId, {
				sourceDuration: 600,
			}),
		).resolves.toBeUndefined();
		await startRevisionChapterGeneration(payload.videoId, payload.revisionId, {
			sourceDuration: 600,
		});
		expect(mocks.start).toHaveBeenCalledOnce();
		expect(markerWrites.at(-1)?.query).toContain(
			"$.chaptersRegenerationQueuedAt",
		);
		expect(markerWrites.at(-1)?.guard).toContain("currentRevisionId");
	});

	it("clears a pending marker when queueing rejects", async () => {
		const { startRevisionChapterGeneration } = await import(
			"@/lib/generate-ai"
		);
		mocks.start.mockRejectedValueOnce(new Error("queue failed"));
		await startRevisionChapterGeneration(payload.videoId, payload.revisionId, {
			sourceDuration: 600,
		});
		expect(markerWrites.at(-1)?.query).toContain("JSON_REMOVE");
		expect(markerWrites.at(-1)?.guard).toContain(
			"$.chaptersRegenerationRevisionId",
		);
	});

	it("queues the chapter workflow only after the real owner Done entrypoint publishes CURRENT", async () => {
		const { publishOwnerRevision } = await import("@/lib/revision-publish");
		const order: string[] = [];
		mocks.publish.mockImplementation(async () => {
			order.push("CURRENT");
			return { success: true, revisionId: payload.revisionId, generation: 6 };
		});
		mocks.record.mockResolvedValue({
			generation: 6,
			draftVersion: 6,
			draftSession: "owner",
		});
		mocks.start.mockImplementation(async () => {
			order.push("queued");
		});
		mocks.db.mockReturnValue({
			update: tx.update,
			select: () => ({
				from: (table: unknown) => ({
					where: async () =>
						table === videos
							? [
									{
										id: payload.videoId,
										ownerId: "owner",
										metadata: metadata(),
										duration: 600,
										source: { type: "webMP4" },
										bucket: null,
										storageIntegrationId: null,
									},
								]
							: [{ snapshot: snapshot() }],
				}),
			}),
		});
		await publishOwnerRevision(
			{
				videoId: payload.videoId as never,
				editSpec: spec,
				baseGeneration: 5,
				draftVersion: 6,
				draftSession: "owner",
			},
			new Headers(),
		);
		await vi.waitFor(() => expect(order).toEqual(["CURRENT", "queued"]));
		expect(mocks.start).toHaveBeenCalledWith(
			workflow.regenerateRevisionChaptersWorkflow,
			[payload],
		);
	});

	it("triggers at 20 percent OR 60 seconds, but not for small trims or manual chapters", () => {
		const trigger = chapterSource.shouldRegenerateRevisionChapters;
		expect(trigger({ sourceDuration: 991.8, outputDuration: 326.6 })).toBe(
			true,
		);
		expect(trigger({ sourceDuration: 100, outputDuration: 80 })).toBe(true);
		expect(trigger({ sourceDuration: 1000, outputDuration: 940 })).toBe(true);
		expect(trigger({ sourceDuration: 1000, outputDuration: 941 })).toBe(false);
		expect(trigger({ sourceDuration: 100, outputDuration: 81 })).toBe(false);
		expect(
			trigger({
				sourceDuration: 991.8,
				outputDuration: 326.6,
				chaptersManuallyEdited: true,
			}),
		).toBe(false);
		expect(trigger({ sourceDuration: Number.NaN, outputDuration: 326.6 })).toBe(
			false,
		);
	});

	it("discards a result if CURRENT changed while AI ran, under the publication lock", async () => {
		mocks.ai.mockImplementation(async () => {
			currentRevisionId = "revision-7";
			return {
				text: JSON.stringify({
					chapters: [
						{ title: "Website", start: 0 },
						{ title: "Apple", start: 200 },
					],
				}),
			};
		});
		expect(await workflow.regenerateRevisionChapters(payload)).toBe(false);
		expect(mocks.ai).toHaveBeenCalledOnce();
		expect(locks).toEqual([videos, videoPublication]);
		expect(writes).toEqual([]);
	});

	it("maps generated OUTPUT chapters to source time across multiple kept ranges", async () => {
		expect(await workflow.regenerateRevisionChapters(payload)).toBe(true);
		expect(saved.sourceChapters).toEqual([
			{ title: "Website", start: 0 },
			{ title: "Airtable and Android", start: 300 },
			{ title: "Apple and DUNS", start: 400 },
		]);
		expect(saved.chapters?.map((c) => c.start)).toEqual([0, 100, 200]);
		expect(
			chapterSource.projectSourceChapters(saved.sourceChapters!, spec),
		).toEqual(saved.chapters);
	});

	it("replaces the single projected DUNS chapter for the 991.8-second owner fixture", async () => {
		// The final long range ends at 859.786, yielding 326.6s after the three slivers.
		spec = makeSpec(991.8, [
			{ start: 0, end: 0.15 },
			{ start: 285.67, end: 285.74 },
			{ start: 312.983, end: 313.053 },
			{ start: 533.476, end: 859.786 },
		]);
		sourceChapters = [
			{ title: "Team Updates & Website Changes", start: 285.82 },
			{ title: "DUNS Number Enrollment Issues", start: 540.9 },
		];
		chapters = chapterSource.projectSourceChapters(sourceChapters, spec);
		expect(chapters.map((c) => c.title)).toEqual([
			"DUNS Number Enrollment Issues",
		]);
		expect(duration()).toBeCloseTo(326.6, 3);
		expect(await workflow.regenerateRevisionChapters(payload)).toBe(true);
		expect(saved.chapters?.map((c) => c.title)).toEqual([
			"Website",
			"Airtable and Android",
			"Apple and DUNS",
		]);
		expect(saved.chaptersRevisionId).toBe(payload.revisionId);
		expect(
			saved.sourceChapters?.find((c) => c.title === "Airtable and Android")
				?.start,
		).toBeCloseTo(633.186, 3);
		const snapshotWrite = writes.find((w) => w.table === editRevision)!;
		expect(snapshotWrite.query).toContain("$.chapters");
		expect(snapshotWrite.params).toContain(JSON.stringify(saved.chapters));
		expect(
			writes.every(
				(w) => !w.query.includes("$.summary") && !w.query.includes("$.aiTitle"),
			),
		).toBe(true);
		expect(mocks.ai.mock.calls[0]![0].prompt).toContain("326.6");
		expect(mocks.ai.mock.calls[0]![0].prompt).not.toContain(
			'"title": "string (concise',
		);
	});

	it("debounces in the existing web workflow before doing any AI work", async () => {
		mocks.sleep.mockImplementation(async () => {
			currentRevisionId = "revision-7";
		});
		expect(await workflow.regenerateRevisionChaptersWorkflow(payload)).toBe(
			false,
		);
		expect(mocks.sleep).toHaveBeenCalledWith("30s");
		expect(mocks.ai).not.toHaveBeenCalled();
		expect(writes).toEqual([]);
	});

	it("protects manual chapters both before AI and when changed during generation", async () => {
		manual = true;
		expect(await workflow.regenerateRevisionChapters(payload)).toBe(false);
		expect(mocks.ai).not.toHaveBeenCalled();
		manual = false;
		mocks.ai.mockImplementation(async () => {
			manual = true;
			return {
				text: JSON.stringify({
					chapters: [
						{ title: "Website", start: 0 },
						{ title: "Apple", start: 200 },
					],
				}),
			};
		});
		expect(await workflow.regenerateRevisionChapters(payload)).toBe(false);
		expect(writes).toEqual([]);
	});

	it("keeps projected chapters on provider failure and has no workflow retries", async () => {
		mocks.ai.mockRejectedValue(new Error("provider unavailable"));
		expect(await workflow.regenerateRevisionChapters(payload)).toBe(false);
		expect(writes).toEqual([]);
		expect(workflow.regenerateRevisionChapters.maxRetries).toBe(0);
	});

	it("keeps projected chapters on invalid, non-cue AI output", async () => {
		mocks.ai.mockResolvedValue({
			text: '{"chapters":[{"title":"Invented","start":55}]}',
		});
		expect(await workflow.regenerateRevisionChapters(payload)).toBe(false);
		expect(writes).toEqual([]);
	});

	it("queues only material automatic edits and does not fail publication on queue errors", async () => {
		const { startRevisionChapterGeneration } = await import(
			"@/lib/generate-ai"
		);
		spec = makeSpec(991.8, [{ start: 0, end: 326.6 }]);
		await startRevisionChapterGeneration(payload.videoId, payload.revisionId, {
			sourceDuration: 991.8,
		});
		expect(mocks.start).toHaveBeenCalledWith(
			workflow.regenerateRevisionChaptersWorkflow,
			[payload],
		);
		spec = makeSpec(991.8, [{ start: 0, end: 980 }]);
		await startRevisionChapterGeneration(payload.videoId, payload.revisionId, {
			sourceDuration: 991.8,
		});
		spec = makeSpec(991.8, [{ start: 0, end: 326.6 }]);
		await startRevisionChapterGeneration(payload.videoId, payload.revisionId, {
			sourceDuration: 991.8,
			chaptersManuallyEdited: true,
		});
		expect(mocks.start).toHaveBeenCalledOnce();
		mocks.start.mockRejectedValueOnce(new Error("queue unavailable"));
		await expect(
			startRevisionChapterGeneration(payload.videoId, payload.revisionId, {
				sourceDuration: 991.8,
			}),
		).resolves.toBeUndefined();
	});

	it("derives output-time captions from the stored source transcript when missing", async () => {
		vtt = "WEBVTT\n";
		mocks.load.mockResolvedValue({
			version: 1,
			durationMs: 600000,
			languageCode: null,
			speechModelUsed: "test",
			words: [
				{
					id: "a",
					text: "Website changes",
					startMs: 100000,
					endMs: 105000,
					confidence: 1,
					speaker: null,
				},
				{
					id: "b",
					text: "Airtable migration",
					startMs: 300000,
					endMs: 305000,
					confidence: 1,
					speaker: null,
				},
				{
					id: "c",
					text: "Apple enrollment",
					startMs: 400000,
					endMs: 405000,
					confidence: 1,
					speaker: null,
				},
			],
		});
		expect(await workflow.regenerateRevisionChapters(payload)).toBe(true);
		expect(mocks.load).toHaveBeenCalledWith(
			expect.anything(),
			payload.videoId,
			spec,
		);
		expect(mocks.ai.mock.calls[0]![0].prompt).toContain("[100] Airtable migration");
		expect(mocks.ai.mock.calls[0]![0].prompt).not.toContain("[6:40]");
	});

	it("reuses section analysis and synthesis for long edits without requesting a title", async () => {
		const longVtt = `WEBVTT\n\n${cue(0, "We review the website launch.")}\n${cue(700, "Next the Apple enrollment requires a DUNS number.")}`;
		mocks.ai
			.mockResolvedValueOnce({
				text: '{"summary":"Website launch","keyPoints":[],"chapters":[{"title":"Website","start":0}]}',
			})
			.mockResolvedValueOnce({
				text: '{"summary":"Apple enrollment","keyPoints":[],"chapters":[{"title":"Apple","start":700}]}',
			})
			.mockResolvedValueOnce({
				text: '{"chapters":[{"title":"Website","start":0},{"title":"Apple","start":700}]}',
			});
		expect(
			await generation.generateChaptersForTranscript(longVtt, 800, "auto"),
		).toEqual([
			{ title: "Website", start: 0 },
			{ title: "Apple", start: 700 },
		]);
		expect(mocks.ai).toHaveBeenCalledTimes(3);
	});

	it("uses explicit output duration, cue snapping, and the existing chapter parser", async () => {
		mocks.ai.mockResolvedValue({
			text: '{"chapters":[{"title":"Website","start":0},{"title":"Apple","start":201.5}]}',
		});
		expect(
			await generation.generateChaptersForTranscript(vtt, 326.6, "auto"),
		).toEqual([
			{ title: "Website", start: 0 },
			{ title: "Apple", start: 200 },
		]);
		expect(mocks.ai).toHaveBeenCalledOnce();
		expect(mocks.ai.mock.calls[0]![0].prompt).toContain("326.6-second video");
	});

	it("labels single-section cues in absolute seconds, the unit chapter starts use", async () => {
		mocks.ai.mockResolvedValue({
			text: '{"chapters":[{"title":"Website","start":0},{"title":"Apple","start":200}]}',
		});
		await generation.generateChaptersForTranscript(vtt, 326.6, "auto");
		const prompt = mocks.ai.mock.calls[0]![0].prompt as string;
		// m:ss labels ("[3:20]") made the model return wrong starts in seconds.
		expect(prompt).toContain("[200] Finally the Apple enrollment");
		expect(prompt).not.toContain("[3:20]");
	});
});

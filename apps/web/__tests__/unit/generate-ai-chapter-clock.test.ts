import {
	editIntent,
	editRevision,
	videoPublication,
	videos,
} from "@cap/database/schema";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectSourceChapters } from "@/lib/revision-chapter-source";
import { parseRenderedCanonicalSpec } from "@/lib/video-edits";
import { generateAiWorkflow } from "@/workflows/generate-ai";

const generateTextMock = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));

vi.mock("ai", () => ({
	APICallError: { isInstance: () => false },
	generateText: generateTextMock,
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

vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));

type Chapter = { title: string; start: number };
type Metadata = {
	summary?: string;
	chapters?: Chapter[];
	sourceChapters?: Chapter[];
	chaptersRevisionId?: string;
	chaptersManuallyEdited?: boolean;
	titleManuallyEdited?: boolean;
	aiGenerationStatus?: string;
	aiGenerationId?: string;
	aiTitle?: string;
	aiChapterBackfillGenerationId?: string;
};
type VideoRow = {
	id: string;
	ownerId: string;
	orgId: null;
	name: string;
	duration: number;
	transcriptionStatus: string;
	source: { type: string };
	metadata: Metadata;
};
type PublicationRow = {
	videoId: string;
	currentRevisionId: string | null;
};
type RevisionRow = {
	revisionId: string;
	videoId: string;
	intentId: string;
	metadataSnapshot: { durationSeconds: number; chapters: Chapter[] };
};
type IntentRow = {
	videoId: string;
	intentId: string;
	canonicalSpec: unknown;
};

const state = {
	videos: [] as VideoRow[],
	publications: [] as PublicationRow[],
	revisions: [] as RevisionRow[],
	intents: [] as IntentRow[],
	locks: [] as string[],
	afterProcessing: undefined as undefined | (() => void),
	beforeCompletion: undefined as undefined | (() => void),
	onPublicationLock: undefined as undefined | (() => void),
	deferUntilCommit: [] as Array<() => void>,
};

const dialect = new MySqlDialect();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function skip(text: string, pos: number) {
	let next = pos;
	while (next < text.length && /\s/.test(text[next] ?? "")) next += 1;
	return next;
}

function jsonUnquote(value: unknown) {
	if (value === null || value === undefined) return null;
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "string" || typeof value === "number")
		return String(value);
	return JSON.stringify(value);
}

function jsonPath(path: unknown) {
	return String(path).replace(/^\$\./, "");
}

function parseQuoted(text: string, pos: number) {
	const quote = text[pos];
	let value = "";
	let next = pos + 1;
	while (next < text.length && text[next] !== quote) {
		value += text[next];
		next += 1;
	}
	return { value, pos: next + 1 };
}

function parseColumn(text: string, row: Record<string, unknown>, pos: number) {
	const match = /^`([^`]+)`(?:\.`([^`]+)`)?/.exec(text.slice(pos));
	if (!match)
		throw new Error(`Cannot read column at ${text.slice(pos, pos + 40)}`);
	const column = match[2] ?? match[1] ?? "";
	const value = column === "metadata" ? (row.metadata ?? {}) : row[column];
	return { value, pos: pos + match[0].length };
}

function parseCall(
	name: string,
	text: string,
	params: unknown[],
	row: Record<string, unknown>,
	pos: number,
): { value: unknown; pos: number } {
	if (name === "CAST") {
		const inner = parseComparison(text, params, row, pos + 1);
		let next = skip(text, inner.pos);
		if (text.slice(next, next + 2).toUpperCase() !== "AS") {
			throw new Error("CAST is missing AS");
		}
		next = skip(text, next + 2);
		const type = /^[A-Za-z]+/.exec(text.slice(next));
		if (!type) throw new Error("CAST is missing a type");
		next = skip(text, next + type[0].length);
		if (text[next] !== ")") throw new Error("CAST is not closed");
		const value =
			type[0].toUpperCase() === "JSON" && typeof inner.value === "string"
				? JSON.parse(inner.value)
				: inner.value;
		return { value, pos: next + 1 };
	}
	const parsed = parseArgList(text, params, row, pos);
	if (name === "JSON_OBJECT") return { value: {}, pos: parsed.pos };
	if (name === "COALESCE") {
		return {
			value:
				parsed.args.find((arg) => arg !== null && arg !== undefined) ?? null,
			pos: parsed.pos,
		};
	}
	if (name === "JSON_EXTRACT") {
		const doc = isRecord(parsed.args[0]) ? parsed.args[0] : {};
		return { value: doc[jsonPath(parsed.args[1])] ?? null, pos: parsed.pos };
	}
	if (name === "JSON_UNQUOTE") {
		return { value: jsonUnquote(parsed.args[0]), pos: parsed.pos };
	}
	if (name === "JSON_SET") {
		const next = {
			...(isRecord(parsed.args[0]) ? parsed.args[0] : {}),
		};
		for (let index = 1; index < parsed.args.length; index += 2) {
			next[jsonPath(parsed.args[index])] = parsed.args[index + 1];
		}
		return { value: next, pos: parsed.pos };
	}
	if (name === "JSON_REMOVE") {
		const next = {
			...(isRecord(parsed.args[0]) ? parsed.args[0] : {}),
		};
		for (const path of parsed.args.slice(1)) delete next[jsonPath(path)];
		return { value: next, pos: parsed.pos };
	}
	if (name === "IF") {
		return {
			value: parsed.args[0] ? parsed.args[1] : parsed.args[2],
			pos: parsed.pos,
		};
	}
	throw new Error(`Unsupported SQL function ${name}`);
}

function parseExpr(
	text: string,
	params: unknown[],
	row: Record<string, unknown>,
	pos: number,
): { value: unknown; pos: number } {
	const start = skip(text, pos);
	if (text[start] === "(") {
		const inner = parseAnd(text, params, row, start + 1);
		const next = skip(text, inner.pos);
		if (text[next] !== ")") throw new Error("Unclosed SQL parenthesis");
		return { value: inner.value, pos: next + 1 };
	}
	if (text[start] === "?") return { value: params.shift(), pos: start + 1 };
	if (text[start] === "'" || text[start] === '"')
		return parseQuoted(text, start);
	if (text[start] === "`") return parseColumn(text, row, start);
	const call = /^([A-Za-z_][A-Za-z0-9_]*)\(/.exec(text.slice(start));
	if (call?.[1]) {
		return parseCall(call[1], text, params, row, start + call[0].length - 1);
	}
	const number = /^-?\d+(?:\.\d+)?/.exec(text.slice(start));
	if (number)
		return { value: Number(number[0]), pos: start + number[0].length };
	throw new Error(`Cannot parse SQL at ${text.slice(start, start + 60)}`);
}

function parseComparison(
	text: string,
	params: unknown[],
	row: Record<string, unknown>,
	pos: number,
) {
	const left = parseExpr(text, params, row, pos);
	const next = skip(text, left.pos);
	const operator = text.startsWith("<=>", next)
		? "<=>"
		: text[next] === "="
			? "="
			: null;
	if (!operator) return left;
	const right = parseExpr(text, params, row, next + operator.length);
	const equal =
		operator === "<=>"
			? left.value === right.value
			: left.value !== null &&
				right.value !== null &&
				left.value === right.value;
	return { value: equal, pos: right.pos };
}

function parseAnd(
	text: string,
	params: unknown[],
	row: Record<string, unknown>,
	pos: number,
) {
	let current = parseComparison(text, params, row, pos);
	let next = skip(text, current.pos);
	while (/^and\b/i.test(text.slice(next))) {
		const right = parseComparison(text, params, row, next + 3);
		current = {
			value: current.value === true && right.value === true,
			pos: right.pos,
		};
		next = skip(text, current.pos);
	}
	return current;
}

function parseArgList(
	text: string,
	params: unknown[],
	row: Record<string, unknown>,
	pos: number,
) {
	let next = skip(text, pos + 1);
	const args: unknown[] = [];
	if (text[next] === ")") return { args, pos: next + 1 };
	while (next < text.length) {
		const parsed = parseComparison(text, params, row, next);
		args.push(parsed.value);
		next = skip(text, parsed.pos);
		if (text[next] === ",") {
			next += 1;
			continue;
		}
		if (text[next] === ")") return { args, pos: next + 1 };
		throw new Error(
			`Expected comma or close at ${text.slice(next, next + 40)}`,
		);
	}
	throw new Error("Unclosed SQL call");
}

function matches(row: VideoRow, expression: unknown) {
	if (
		!expression ||
		typeof expression !== "object" ||
		!("queryChunks" in expression)
	) {
		return true;
	}
	const query = dialect.sqlToQuery(expression as never);
	const parsed = parseAnd(query.sql, [...query.params], row, 0);
	return parsed.value === true;
}

function applyMetadata(row: VideoRow, expression: unknown) {
	const query = dialect.sqlToQuery(expression as never);
	const parsed = parseComparison(query.sql, [...query.params], row, 0);
	if (!isRecord(parsed.value)) {
		throw new Error(
			`Metadata SQL did not return an object: ${query.sql.slice(0, 120)}`,
		);
	}
	row.metadata = parsed.value as Metadata;
}

const database = {
	select(fields?: Record<string, unknown>) {
		let table: unknown;
		let joinedOrganization = false;
		const joined = new Set<unknown>();
		const chain = {
			from(next: unknown) {
				table = next;
				return chain;
			},
			leftJoin() {
				joinedOrganization = true;
				return chain;
			},
			innerJoin(next: unknown) {
				joined.add(next);
				return chain;
			},
			where(condition: unknown) {
				const run = async () => {
					if (table === videos) {
						const rows = state.videos.filter((row) => matches(row, condition));
						if (joinedOrganization) {
							return rows.map((video) => ({ video, orgSettings: null }));
						}
						if (fields && "id" in fields && Object.keys(fields).length === 1) {
							return rows.map((row) => ({ id: row.id }));
						}
						return rows;
					}
					if (table === videoPublication) {
						const videoId = stringParam(condition);
						const publication = state.publications.find(
							(row) => !videoId || row.videoId === videoId,
						);
						if (!publication) return [];
						if (!joined.has(editRevision)) return [publication];
						const revision = state.revisions.find(
							(row) => row.revisionId === publication.currentRevisionId,
						);
						if (!revision || !joined.has(editIntent))
							return revision ? [revision] : [];
						const intent = state.intents.find(
							(row) => row.intentId === revision.intentId,
						);
						if (!intent) return [];
						return [
							{
								revisionId: revision.revisionId,
								metadataSnapshot: revision.metadataSnapshot,
								canonicalSpec: intent.canonicalSpec,
							},
						];
					}
					return [];
				};
				const pending = run();
				return Object.assign(pending, {
					for(mode: string) {
						if (mode === "update") {
							state.locks.push(
								table === videos ? "videos" : "videoPublication",
							);
							if (table === videoPublication) state.onPublicationLock?.();
						}
						return pending;
					},
				});
			},
		};
		return chain;
	},
	update(table: unknown) {
		return {
			set(values: { metadata?: unknown; name?: string }) {
				return {
					where: async (condition: unknown) => {
						if (table !== videos) return [{ affectedRows: 0 }];
						if (
							values.metadata &&
							isRecord(values.metadata) &&
							"queryChunks" in values.metadata &&
							dialect
								.sqlToQuery(values.metadata as never)
								.sql.includes("'COMPLETE'")
						) {
							state.beforeCompletion?.();
						}
						const rows = state.videos.filter((row) => matches(row, condition));
						for (const row of rows) {
							if (
								values.metadata &&
								isRecord(values.metadata) &&
								"queryChunks" in values.metadata
							) {
								applyMetadata(row, values.metadata);
							}
							if (typeof values.name === "string") row.name = values.name;
						}
						if (
							rows.some(
								(row) => row.metadata.aiGenerationStatus === "PROCESSING",
							)
						) {
							state.afterProcessing?.();
						}
						return [{ affectedRows: rows.length }];
					},
				};
			},
		};
	},
	async transaction(run: (tx: typeof database) => Promise<unknown>) {
		const result = await run(database);
		const deferred = state.deferUntilCommit.splice(0);
		for (const change of deferred) change();
		return result;
	},
};

function stringParam(expression: unknown) {
	if (
		!expression ||
		typeof expression !== "object" ||
		!("queryChunks" in expression)
	) {
		return undefined;
	}
	const params = dialect.sqlToQuery(expression as never).params;
	return params.find((value): value is string => typeof value === "string");
}

vi.mock("@cap/database", () => ({
	db: () => database,
}));

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

const TRANSCRIPT = `WEBVTT

00:00:00.000 --> 00:00:08.000
Opening words about the work.

00:00:08.000 --> 00:00:25.000
Early phase continues here.

00:00:25.000 --> 00:00:40.000
Removed section stays in source.

00:00:40.000 --> 00:00:60.000
Shifted section after the cut.

00:01:00.000 --> 00:01:30.000
Later phase covers the ending.
`;

const GENERATED: Chapter[] = [
	{ title: "Opening", start: 0 },
	{ title: "Early phase", start: 8 },
	{ title: "Removed section", start: 25 },
	{ title: "Shifted section", start: 40 },
	{ title: "Later phase", start: 60 },
];

const EDITED_SPEC = {
	version: 1 as const,
	sourceDuration: 90,
	keepRanges: [
		{ start: 0, end: 20 },
		{ start: 50, end: 90 },
	],
};

const FULL_SPEC = {
	version: 1 as const,
	sourceDuration: 90,
	keepRanges: [{ start: 0, end: 90 }],
};

const REVISION_ID = "current-revision";

function seed(metadata: Metadata = {}) {
	state.locks = [];
	state.afterProcessing = undefined;
	state.beforeCompletion = undefined;
	state.onPublicationLock = undefined;
	state.deferUntilCommit = [];
	state.videos = [
		{
			id: "video-1",
			ownerId: "owner-1",
			orgId: null,
			name: "Manual title",
			duration: 60,
			transcriptionStatus: "COMPLETE",
			source: { type: "webMP4" },
			metadata: {
				summary: "Saved summary",
				titleManuallyEdited: true,
				chaptersRevisionId: REVISION_ID,
				aiGenerationStatus: "QUEUED",
				aiGenerationId: "generation-1",
				...metadata,
			},
		},
	];
	state.publications = [{ videoId: "video-1", currentRevisionId: REVISION_ID }];
	state.revisions = [
		{
			revisionId: REVISION_ID,
			videoId: "video-1",
			intentId: "intent-1",
			metadataSnapshot: { durationSeconds: 60, chapters: [] },
		},
	];
	state.intents = [
		{
			videoId: "video-1",
			intentId: "intent-1",
			canonicalSpec: EDITED_SPEC,
		},
	];
}

const previousOwners = process.env.CAP_INSTANT_FINISH_OWNERS;

describe("AI generation save chapter clock", () => {
	beforeEach(() => {
		process.env.CAP_INSTANT_FINISH_OWNERS = "owner-1";
		seed();
		generateTextMock.mockResolvedValue({
			text: JSON.stringify({
				title: "Generated title",
				chapters: GENERATED,
			}),
		});
	});

	afterEach(() => {
		if (previousOwners === undefined) {
			delete process.env.CAP_INSTANT_FINISH_OWNERS;
		} else {
			process.env.CAP_INSTANT_FINISH_OWNERS = previousOwners;
		}
	});

	it("projects source-time chapters through the committed CURRENT spec and keeps hidden chapters canonical", async () => {
		const spec = parseRenderedCanonicalSpec(EDITED_SPEC);
		const visible = projectSourceChapters(GENERATED, spec);

		const result = await generateAiWorkflow({
			videoId: "video-1",
			userId: "owner-1",
			generationId: "generation-1",
		});

		expect(result).toEqual({
			success: true,
			message: "AI generation completed successfully",
		});
		const metadata = state.videos[0]?.metadata;
		expect(metadata?.chapters).toEqual(visible);
		expect(metadata?.sourceChapters).toEqual(GENERATED);
		expect(metadata?.chaptersRevisionId).toBe(REVISION_ID);
		expect(metadata?.summary).toBe("Saved summary");
		expect(state.videos[0]?.name).toBe("Manual title");
		expect(
			projectSourceChapters(
				metadata?.sourceChapters ?? [],
				parseRenderedCanonicalSpec(FULL_SPEC),
			),
		).toEqual(
			projectSourceChapters(GENERATED, parseRenderedCanonicalSpec(FULL_SPEC)),
		);
		expect(
			metadata?.chapters?.some(
				(chapter) => chapter.title === "Removed section",
			),
		).toBe(false);
	});

	it("clears a stale revision tag when flag-off generation writes a different chapter clock", async () => {
		process.env.CAP_INSTANT_FINISH_OWNERS = "";
		seed({
			sourceChapters: [{ title: "Old source", start: 11 }],
			chaptersRevisionId: REVISION_ID,
		});

		const result = await generateAiWorkflow({
			videoId: "video-1",
			userId: "owner-1",
			generationId: "generation-1",
		});

		expect(result).toEqual({
			success: true,
			message: "AI generation completed successfully",
		});
		const metadata = state.videos[0]?.metadata;
		expect(metadata?.chapters).toEqual(GENERATED);
		expect(metadata?.chaptersRevisionId).toBeUndefined();
		expect(metadata?.sourceChapters).toBeUndefined();
		expect(metadata?.summary).toBe("Saved summary");
	});

	it("clears inconsistent provenance when a flagged owner has no CURRENT", async () => {
		seed({
			sourceChapters: [{ title: "Old source", start: 11 }],
			chaptersRevisionId: "stale-revision",
		});
		state.publications = [];

		const result = await generateAiWorkflow({
			videoId: "video-1",
			userId: "owner-1",
			generationId: "generation-1",
		});

		expect(result).toEqual({
			success: true,
			message: "AI generation completed successfully",
		});
		const metadata = state.videos[0]?.metadata;
		expect(metadata?.chapters).toEqual(GENERATED);
		expect(metadata?.chaptersRevisionId).toBeUndefined();
		expect(metadata?.sourceChapters).toBeUndefined();
		expect(metadata?.summary).toBe("Saved summary");
	});

	it("does not overwrite owner chapters or their revision tag when the manual flag lands before commit", async () => {
		state.beforeCompletion = () => {
			const metadata = state.videos[0]?.metadata;
			if (!metadata) return;
			metadata.chaptersManuallyEdited = true;
			metadata.chapters = [{ title: "Owner chapter", start: 4 }];
			metadata.sourceChapters = [{ title: "Owner source", start: 12 }];
			metadata.chaptersRevisionId = "owner-revision";
		};

		const result = await generateAiWorkflow({
			videoId: "video-1",
			userId: "owner-1",
			generationId: "generation-1",
		});

		expect(result.message).toBe("AI generation completed successfully");
		const metadata = state.videos[0]?.metadata;
		expect(metadata).toMatchObject({
			chaptersManuallyEdited: true,
			chapters: [{ title: "Owner chapter", start: 4 }],
			sourceChapters: [{ title: "Owner source", start: 12 }],
			chaptersRevisionId: "owner-revision",
			aiGenerationStatus: "COMPLETE",
			summary: "Saved summary",
		});
	});

	it("rejects a stale generation without writing chapters", async () => {
		state.beforeCompletion = () => {
			const metadata = state.videos[0]?.metadata;
			if (metadata) metadata.aiGenerationId = "newer-generation";
		};

		const result = await generateAiWorkflow({
			videoId: "video-1",
			userId: "owner-1",
			generationId: "generation-1",
		});

		expect(result).toEqual({
			success: true,
			message: "AI generation claim is no longer current",
		});
		expect(state.videos[0]?.metadata).toMatchObject({
			aiGenerationStatus: "PROCESSING",
			aiGenerationId: "newer-generation",
			chaptersRevisionId: REVISION_ID,
			summary: "Saved summary",
		});
		expect(state.videos[0]?.metadata.chapters).toBeUndefined();
		expect(state.videos[0]?.metadata.sourceChapters).toBeUndefined();
	});

	it("projects through the CURRENT that committed while generation was running", async () => {
		state.afterProcessing = () => {
			state.publications[0] = {
				videoId: "video-1",
				currentRevisionId: "later-revision",
			};
			state.revisions.push({
				revisionId: "later-revision",
				videoId: "video-1",
				intentId: "intent-later",
				metadataSnapshot: { durationSeconds: 90, chapters: [] },
			});
			state.intents.push({
				videoId: "video-1",
				intentId: "intent-later",
				canonicalSpec: FULL_SPEC,
			});
		};

		await generateAiWorkflow({
			videoId: "video-1",
			userId: "owner-1",
			generationId: "generation-1",
		});

		const metadata = state.videos[0]?.metadata;
		expect(metadata?.chapters).toEqual(
			projectSourceChapters(GENERATED, parseRenderedCanonicalSpec(FULL_SPEC)),
		);
		expect(metadata?.chaptersRevisionId).toBe("later-revision");
		expect(metadata?.sourceChapters).toEqual(GENERATED);
	});

	it("tags the locked CURRENT when a publication mutation is waiting on the same lock", async () => {
		state.onPublicationLock = () => {
			state.deferUntilCommit.push(() => {
				const publication = state.publications[0];
				const intent = state.intents[0];
				if (publication) publication.currentRevisionId = "racer-revision";
				if (intent) intent.canonicalSpec = FULL_SPEC;
			});
		};

		await generateAiWorkflow({
			videoId: "video-1",
			userId: "owner-1",
			generationId: "generation-1",
		});

		const metadata = state.videos[0]?.metadata;
		expect(state.locks).toEqual(["videos", "videoPublication"]);
		expect(metadata?.chaptersRevisionId).toBe(REVISION_ID);
		expect(metadata?.chapters).toEqual(
			projectSourceChapters(GENERATED, parseRenderedCanonicalSpec(EDITED_SPEC)),
		);
		expect(state.publications[0]?.currentRevisionId).toBe("racer-revision");
	});

	it("keeps revision provenance when a flag-off rewrite does not change the chapter clock", async () => {
		process.env.CAP_INSTANT_FINISH_OWNERS = "";
		seed({
			chapters: GENERATED.map((chapter) => ({ ...chapter })),
			sourceChapters: [{ title: "Kept source", start: 1 }],
			chaptersRevisionId: REVISION_ID,
			aiChapterBackfillGenerationId: "generation-1",
		});
		const video = state.videos[0];
		if (video) video.duration = 120;

		await generateAiWorkflow({
			videoId: "video-1",
			userId: "owner-1",
			generationId: "generation-1",
		});

		expect(state.videos[0]?.metadata).toMatchObject({
			chapters: GENERATED,
			sourceChapters: [{ title: "Kept source", start: 1 }],
			chaptersRevisionId: REVISION_ID,
			summary: "Saved summary",
			aiGenerationStatus: "COMPLETE",
		});
		expect(
			state.videos[0]?.metadata.aiChapterBackfillGenerationId,
		).toBeUndefined();
	});

	it("does not clear revision provenance when a manual edit wins the flag-off commit", async () => {
		process.env.CAP_INSTANT_FINISH_OWNERS = "";
		seed({
			sourceChapters: [{ title: "Old source", start: 11 }],
			chaptersRevisionId: REVISION_ID,
		});
		state.beforeCompletion = () => {
			const metadata = state.videos[0]?.metadata;
			if (!metadata) return;
			metadata.chaptersManuallyEdited = true;
			metadata.chapters = [{ title: "Owner chapter", start: 4 }];
			metadata.sourceChapters = [{ title: "Owner source", start: 12 }];
			metadata.chaptersRevisionId = "owner-revision";
		};

		await generateAiWorkflow({
			videoId: "video-1",
			userId: "owner-1",
			generationId: "generation-1",
		});

		expect(state.videos[0]?.metadata).toMatchObject({
			chaptersManuallyEdited: true,
			chapters: [{ title: "Owner chapter", start: 4 }],
			sourceChapters: [{ title: "Owner source", start: 12 }],
			chaptersRevisionId: "owner-revision",
			summary: "Saved summary",
			aiGenerationStatus: "COMPLETE",
		});
	});

	it("does not write chapter fields on an unrelated video", async () => {
		const unrelated: VideoRow = {
			id: "video-2",
			ownerId: "owner-2",
			orgId: null,
			name: "Other title",
			duration: 40,
			transcriptionStatus: "COMPLETE",
			source: { type: "webMP4" },
			metadata: {
				summary: "Other summary",
				chapters: [{ title: "Other chapter", start: 1 }],
				sourceChapters: [{ title: "Other source", start: 2 }],
				chaptersRevisionId: "other-revision",
				aiGenerationStatus: "COMPLETE",
				aiGenerationId: "other-generation",
			},
		};
		state.videos.push(structuredClone(unrelated));
		state.publications.push({
			videoId: "video-2",
			currentRevisionId: "other-revision",
		});

		await generateAiWorkflow({
			videoId: "video-1",
			userId: "owner-1",
			generationId: "generation-1",
		});

		expect(state.videos.find((row) => row.id === "video-2")).toEqual(unrelated);
		expect(state.locks).toEqual(["videos", "videoPublication"]);
	});

	it("stores canonical source chapters when CURRENT is an unedited timeline", async () => {
		const intent = state.intents[0];
		if (intent) intent.canonicalSpec = FULL_SPEC;

		await generateAiWorkflow({
			videoId: "video-1",
			userId: "owner-1",
			generationId: "generation-1",
		});

		const metadata = state.videos[0]?.metadata;
		expect(metadata?.sourceChapters).toEqual(GENERATED);
		expect(metadata?.chapters).toEqual(
			projectSourceChapters(GENERATED, parseRenderedCanonicalSpec(FULL_SPEC)),
		);
		expect(metadata?.chaptersRevisionId).toBe(REVISION_ID);
		expect(
			metadata?.chapters?.some((chapter) => chapter.title === "Opening"),
		).toBe(false);
		expect(
			metadata?.sourceChapters?.some((chapter) => chapter.title === "Opening"),
		).toBe(true);
	});
});

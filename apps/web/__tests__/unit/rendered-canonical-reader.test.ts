import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	restoredEditorSpec,
	selectEditorBaselineSpec,
} from "@/lib/editor-baseline";
import {
	outputChaptersToSource,
	projectSourceChapters,
} from "@/lib/revision-chapter-source";
import {
	parseTimelineDraft,
	serializeTimelineDraft,
} from "@/lib/video-edit-drafts";
import {
	createTimelineHistory,
	createTimelineStateFromEditSpec,
	expectedEditFenceMatches,
	getTimelineEditSpec,
	getTimelineKeepRanges,
	getTimelineSegments,
	normalizeTimelineState,
	parseRenderedCanonicalSpec,
	parseVideoEditSpec,
	pushTimelineHistory,
	redoTimelineHistory,
	setTimelineAutoCutLayer,
	setTimelineTrim,
	undoTimelineHistory,
} from "@/lib/video-edits";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const silence = {
	enabled: true,
	ranges: [{ start: 0.4, end: 0.5 }],
	thresholdMs: 800,
	padMs: 150,
	removedMs: 100,
	gapCount: 1,
};
const fillersOff = {
	enabled: false,
	ranges: [] as { start: number; end: number }[],
	mode: "ums" as const,
	padMs: 80,
	removedCount: 0,
	skippedCount: 0,
};

const reviewStored = {
	version: 2 as const,
	sourceDuration: 2,
	manualKeepRanges: [{ start: 0, end: 2 }],
	keepRanges: [
		{ start: 0, end: 0.4 },
		{ start: 0.7, end: 2 },
	],
	autoCuts: { silence, fillers: fillersOff },
};
const reviewAuthored = [
	{ start: 0, end: 0.4 },
	{ start: 0.5, end: 2 },
];
const reviewRendered = reviewStored.keepRanges;

const islandStored = {
	version: 2 as const,
	sourceDuration: 2,
	manualKeepRanges: [{ start: 0, end: 2 }],
	keepRanges: [
		{ start: 0, end: 0.4 },
		{ start: 0.7, end: 2 },
	],
	autoCuts: {
		silence,
		fillers: {
			enabled: true,
			ranges: [{ start: 0.57, end: 0.7 }],
			mode: "ums" as const,
			padMs: 80,
			removedCount: 1,
			skippedCount: 0,
		},
	},
};

function keptSegments(
	state: ReturnType<typeof createTimelineStateFromEditSpec>,
) {
	return getTimelineSegments(state)
		.filter((segment) => !segment.deleted)
		.map((segment) => ({ start: segment.start, end: segment.end }));
}

describe("rendered canonical readers", () => {
	it("keeps ordinary authoring parse and preserves a sealed narrowing", () => {
		expect(parseVideoEditSpec(reviewStored).keepRanges).toEqual(reviewAuthored);
		const rendered = parseRenderedCanonicalSpec(reviewStored);
		expect(rendered.keepRanges).toEqual(reviewRendered);
		if (rendered.version !== 2) throw new Error("expected v2");
		expect(rendered.manualKeepRanges).toEqual([{ start: 0, end: 2 }]);
		expect(rendered.autoCuts.silence.ranges).toEqual(silence.ranges);
		expect(rendered.autoCuts.silence.enabled).toBe(true);
		expect(
			expectedEditFenceMatches(rendered, parseVideoEditSpec(reviewStored)),
		).toBe(true);
		expect(
			parseRenderedCanonicalSpec({
				...reviewStored,
				keepRanges: [{ start: 0, end: 2 }],
			}).keepRanges,
		).toEqual(reviewAuthored);
		expect(
			parseRenderedCanonicalSpec({
				version: 1,
				sourceDuration: 2,
				keepRanges: [{ start: 0, end: 1 }],
			}),
		).toEqual(
			parseVideoEditSpec({
				version: 1,
				sourceDuration: 2,
				keepRanges: [{ start: 0, end: 1 }],
			}),
		);
	});

	it("round-trips selected keeps through the initial editor without rewriting policy", () => {
		const baseline = selectEditorBaselineSpec({
			instantFinish: true,
			publishedIntentSpec: parseRenderedCanonicalSpec(reviewStored),
			legacySpec: null,
			sourceDuration: 2,
		});
		const state = createTimelineStateFromEditSpec(baseline);
		expect(getTimelineKeepRanges(state)).toEqual(reviewRendered);
		expect(keptSegments(state)).toEqual(reviewRendered);
		const spec = getTimelineEditSpec(state);
		expect(spec.keepRanges).toEqual(reviewRendered);
		expect(spec.manualKeepRanges).toEqual([{ start: 0, end: 2 }]);
		expect(spec.autoCuts.silence.enabled).toBe(true);
		expect(spec.autoCuts.silence.ranges).toEqual([{ start: 0.4, end: 0.5 }]);
		expect(state.deletedRanges).toEqual([]);
		const again = createTimelineStateFromEditSpec(spec);
		expect(getTimelineKeepRanges(again)).toEqual(reviewRendered);
		expect(getTimelineEditSpec(again).manualKeepRanges).toEqual([
			{ start: 0, end: 2 },
		]);
		expect(getTimelineKeepRanges(normalizeTimelineState({ ...state }))).toEqual(
			reviewRendered,
		);
	});

	it("maps chapters through rendered keeps, not reconstituted islands", () => {
		const spec = parseRenderedCanonicalSpec(reviewStored);
		expect(
			outputChaptersToSource([{ title: "Later", start: 0.5 }], spec),
		).toEqual([{ title: "Later", start: 0.8 }]);
		expect(
			projectSourceChapters([{ title: "Island", start: 0.6 }], spec)[0]?.start,
		).toBe(0.4);
		const authored = parseVideoEditSpec(reviewStored);
		expect(
			outputChaptersToSource([{ title: "Later", start: 0.5 }], authored)[0]
				?.start,
		).toBe(0.6);
	});

	it("recomputes when trim or auto-cuts change, and undo restores published geometry", () => {
		const state = createTimelineStateFromEditSpec(
			parseRenderedCanonicalSpec(reviewStored),
		);
		const trimmed = setTimelineTrim(state, 0.1, 2);
		expect(getTimelineKeepRanges(trimmed)).toEqual([
			{ start: 0.1, end: 0.4 },
			{ start: 0.5, end: 2 },
		]);
		const cutsOff = setTimelineAutoCutLayer(state, "silence", {
			enabled: false,
		});
		expect(getTimelineKeepRanges(cutsOff)).toEqual([{ start: 0, end: 2 }]);
		expect(cutsOff.deletedRanges).toEqual([]);
		let history = createTimelineHistory(state);
		history = pushTimelineHistory(history, cutsOff);
		history = undoTimelineHistory(history);
		expect(
			getTimelineKeepRanges(history.entries[history.index] ?? state),
		).toEqual(reviewRendered);
		history = redoTimelineHistory(history);
		expect(
			getTimelineKeepRanges(history.entries[history.index] ?? state),
		).toEqual([{ start: 0, end: 2 }]);
		history = undoTimelineHistory(history);
		expect(
			getTimelineKeepRanges(history.entries[history.index] ?? state),
		).toEqual(reviewRendered);
	});

	it("returns a dropped island when the isolating cut is turned off", () => {
		const state = createTimelineStateFromEditSpec(
			parseRenderedCanonicalSpec(islandStored),
		);
		expect(getTimelineKeepRanges(state)).toEqual(islandStored.keepRanges);
		expect(state.deletedRanges).toEqual([]);
		const fillersOffState = setTimelineAutoCutLayer(state, "fillers", {
			enabled: false,
		});
		expect(getTimelineKeepRanges(fillersOffState)).toEqual([
			{ start: 0, end: 0.4 },
			{ start: 0.5, end: 2 },
		]);
		expect(
			getTimelineKeepRanges(fillersOffState).some(
				(range) => range.start <= 0.5 && range.end >= 0.57,
			),
		).toBe(true);
		expect(fillersOffState.deletedRanges).toEqual([]);
	});

	it("clears published geometry on Restore and keeps it through draft clone", () => {
		const parsed = parseRenderedCanonicalSpec(reviewStored);
		const state = createTimelineStateFromEditSpec(parsed);
		const restored = createTimelineStateFromEditSpec(restoredEditorSpec(2));
		expect(getTimelineKeepRanges(restored)).toEqual([{ start: 0, end: 2 }]);
		expect(restored.renderedKeeps).toBeUndefined();
		const loaded = parseTimelineDraft(
			serializeTimelineDraft(2, state, parsed),
			2,
			parsed,
		);
		expect(loaded).not.toBeNull();
		expect(getTimelineKeepRanges(loaded ?? state)).toEqual(reviewRendered);
	});

	it("wires the editor and chapter readers to the rendered parser", () => {
		const page = readFileSync(
			join(webRoot, "app/s/[videoId]/edit/page.tsx"),
			"utf8",
		);
		const chapters = readFileSync(
			join(webRoot, "actions/videos/edit-ai-content.ts"),
			"utf8",
		);
		expect(page).toContain(
			"parseRenderedCanonicalSpec(publishedIntent.canonicalSpec)",
		);
		expect(page).toContain("parseVideoEditSpec(existingEdit.editSpec)");
		expect(chapters).toContain("parseRenderedCanonicalSpec(row.canonicalSpec)");
		expect(chapters).not.toContain("parseVideoEditSpec(row.canonicalSpec)");
	});
});

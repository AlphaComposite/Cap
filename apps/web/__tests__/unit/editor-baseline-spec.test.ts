import { describe, expect, it } from "vitest";
import {
	editorHasExistingEdits,
	restoredEditorSpec,
	selectEditorBaselineSpec,
} from "@/lib/editor-baseline";
import { restoreRoute } from "@/lib/revision-done";
import { previousEditionSpec } from "@/lib/revision-publication-metadata";
import {
	areEditSpecDocumentsEquivalent,
	createIdentityEditSpec,
	createTimelineStateFromEditSpec,
	getEditSpecOutputDuration,
	getTimelineEditSpec,
} from "@/lib/video-edits";

// cap-fzp.8.7.31: after the first instant-finish publish, video_edits (legacy rollback row)
// and the published edit_intent differ. The editor baseline must match the server's
// previousEditionSpec or every later Done is refused 409 ("edited in another session").
const legacy = {
	...createIdentityEditSpec(65.659),
	keepRanges: [{ start: 0, end: 65.659 }],
	manualKeepRanges: [{ start: 0, end: 65.659 }],
};
const published = {
	...createIdentityEditSpec(65.659),
	keepRanges: [{ start: 0, end: 65.559 }],
	manualKeepRanges: [{ start: 0, end: 65.559 }],
};

describe("selectEditorBaselineSpec", () => {
	it("prefers the published intent over a stale legacy row, matching the server", () => {
		const baseline = selectEditorBaselineSpec({
			instantFinish: true,
			publishedIntentSpec: published,
			legacySpec: legacy,
			sourceDuration: 65.659,
		});
		const server = previousEditionSpec({
			currentSpec: published,
			rollbackSpec: legacy,
			sourceDuration: 65.659,
		});
		expect(areEditSpecDocumentsEquivalent(server, baseline)).toBe(true);
		expect(areEditSpecDocumentsEquivalent(legacy, baseline)).toBe(false);
	});

	it("falls back to the legacy row, then identity", () => {
		expect(
			selectEditorBaselineSpec({
				instantFinish: true,
				publishedIntentSpec: null,
				legacySpec: legacy,
				sourceDuration: 65.659,
			}),
		).toEqual(legacy);
		expect(
			selectEditorBaselineSpec({
				instantFinish: true,
				publishedIntentSpec: null,
				legacySpec: null,
				sourceDuration: 10,
			}),
		).toEqual(createIdentityEditSpec(10));
	});

	it("ignores the published intent when instant finish is off (legacy editor unchanged)", () => {
		expect(
			selectEditorBaselineSpec({
				instantFinish: false,
				publishedIntentSpec: published,
				legacySpec: legacy,
				sourceDuration: 65.659,
			}),
		).toEqual(legacy);
	});
});

// cap-fzp.8.7.34: Restore must be available for instant-finish edits even
// without a legacy video_edits row.
describe("editorHasExistingEdits", () => {
	it("is true for a published instant-finish edit with no legacy row", () => {
		expect(
			editorHasExistingEdits({
				instantFinish: true,
				hasLegacyRow: false,
				baseline: published,
			}),
		).toBe(true);
	});
	it("is false for an uncut baseline", () => {
		expect(
			editorHasExistingEdits({
				instantFinish: true,
				hasLegacyRow: false,
				baseline: createIdentityEditSpec(65.659),
			}),
		).toBe(false);
	});
	it("keeps legacy behavior when instant finish is off", () => {
		expect(
			editorHasExistingEdits({
				instantFinish: false,
				hasLegacyRow: false,
				baseline: published,
			}),
		).toBe(false);
		expect(
			editorHasExistingEdits({
				instantFinish: false,
				hasLegacyRow: true,
				baseline: published,
			}),
		).toBe(true);
	});
});

// cap-fzp.8.7.34: Restore must stay uncut; the transcript sidebar must not
// silently re-apply pause/filler auto-cuts after Restore.
describe("restoredEditorSpec", () => {
	it("is the full uncut video with auto-cuts off and marked initialized", () => {
		const spec = getTimelineEditSpec(
			createTimelineStateFromEditSpec(restoredEditorSpec(65.659)),
		);
		expect(getEditSpecOutputDuration(spec)).toBeCloseTo(65.659, 3);
		expect(spec.autoCutsInitialized).toBe(true);
		if (spec.version === 2) {
			expect(spec.autoCuts?.silence.enabled ?? false).toBe(false);
			expect(spec.autoCuts?.fillers.enabled ?? false).toBe(false);
		}
	});
});

// cap-fzp.8.7.34 (Sol re-review): Restore must wait for the instant-finish
// flag like Done, or an early click takes the legacy path that throws.
describe("restoreRoute", () => {
	it("waits until the flag state is known", () => {
		expect(restoreRoute(undefined)).toBe("wait");
		expect(restoreRoute(null)).toBe("wait");
	});
	it("uses the editor reset when instant finish is on, legacy otherwise", () => {
		expect(restoreRoute({ enabled: true })).toBe("editor");
		expect(restoreRoute({ enabled: false })).toBe("legacy");
	});
});

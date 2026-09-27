import { describe, expect, it } from "vitest";
import { selectEditorBaselineSpec } from "@/lib/editor-baseline";
import { previousEditionSpec } from "@/lib/revision-publication-metadata";
import {
	areEditSpecDocumentsEquivalent,
	createIdentityEditSpec,
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

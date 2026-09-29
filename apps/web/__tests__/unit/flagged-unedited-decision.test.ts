import { describe, expect, it } from "vitest";
import {
	decideEligibleLegacy,
	isSourceRelocated,
} from "@/lib/flagged-unedited";

const eligible = {
	flagged: true,
	hasEditIntent: false,
	hasVideoEdits: false,
	editProcessing: false,
	relocated: false,
};

describe("flagged unedited eligibility", () => {
	it("allows only a flagged video with no edit, no processing and a live source", () => {
		expect(decideEligibleLegacy(eligible)).toBe(true);
		expect(decideEligibleLegacy({ ...eligible, flagged: false })).toBe(false);
		expect(decideEligibleLegacy({ ...eligible, hasEditIntent: true })).toBe(
			false,
		);
		expect(decideEligibleLegacy({ ...eligible, hasVideoEdits: true })).toBe(
			false,
		);
		expect(decideEligibleLegacy({ ...eligible, editProcessing: true })).toBe(
			false,
		);
		expect(decideEligibleLegacy({ ...eligible, relocated: true })).toBe(false);
	});

	it("treats every relocation state except LIVE as moved", () => {
		expect(isSourceRelocated(null)).toBe(false);
		expect(
			isSourceRelocated({ relocationState: "LIVE", liveKey: "u/v/result.mp4" }),
		).toBe(false);
		for (const state of ["INTENT", "COPIED", "POINTER", "DELETED", "PURGED"]) {
			expect(
				isSourceRelocated({
					relocationState: state,
					liveKey: "u/v/result.mp4",
				}),
			).toBe(true);
		}
		expect(
			isSourceRelocated({
				relocationState: "LIVE",
				liveKey: "private/u/v/result.mp4",
			}),
		).toBe(true);
	});
});

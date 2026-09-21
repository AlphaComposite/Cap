import { describe, expect, it } from "vitest";
import { isSummaryTabDisabled } from "@/app/s/[videoId]/_components/summary-visibility";

describe("summary tab visibility", () => {
	it("keeps the summary editor available to the owner", () => {
		expect(isSummaryTabDisabled(true, true)).toBe(false);
		expect(isSummaryTabDisabled(true, false)).toBe(false);
	});

	it("hides the summary editor from non-owners", () => {
		expect(isSummaryTabDisabled(false, true)).toBe(true);
		expect(isSummaryTabDisabled(false, false)).toBe(true);
	});
});

import { describe, expect, it } from "vitest";
import { isSummaryTabDisabled } from "@/app/s/[videoId]/_components/summary-visibility";

describe("summary tab visibility", () => {
	it("keeps a disabled viewer summary available to the owner", () => {
		expect(isSummaryTabDisabled(true, true)).toBe(false);
	});

	it("hides a disabled summary from non-owners", () => {
		expect(isSummaryTabDisabled(false, true)).toBe(true);
		expect(isSummaryTabDisabled(false, false)).toBe(false);
	});
});

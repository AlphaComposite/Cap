import { describe, expect, it } from "vitest";
import {
	abortedPrepareShouldFail,
	PUBLISH_JOINED_PREPARE,
} from "@/lib/revision-prepare-abort";

describe("aborted prepare", () => {
	it("fails an unjoined in-flight prepare", () => {
		expect(
			abortedPrepareShouldFail({ state: "COMMITTED_INTENT", error: null }),
		).toBe(true);
		expect(abortedPrepareShouldFail({ state: "PREPARING", error: null })).toBe(
			true,
		);
	});

	it("does not fail a prepare a publish has joined", () => {
		expect(
			abortedPrepareShouldFail({
				state: "PREPARING",
				error: PUBLISH_JOINED_PREPARE,
			}),
		).toBe(false);
		expect(
			abortedPrepareShouldFail({
				state: "COMMITTED_INTENT",
				error: PUBLISH_JOINED_PREPARE,
			}),
		).toBe(false);
	});

	it("does not fail a finished or terminal revision", () => {
		for (const state of [
			"READY",
			"PUBLISHING",
			"CURRENT",
			"FAILED",
			"SUPERSEDED",
		]) {
			expect(abortedPrepareShouldFail({ state, error: null })).toBe(false);
		}
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrepareOnce, prepareSpecKey } from "@/lib/revision-prepare-once";

describe("one prepare per Done", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("posts prepare once when Done is 50 ms after the change", () => {
		vi.useFakeTimers();
		const once = createPrepareOnce();
		const posts: string[] = [];
		once.arm("spec-a", 150, () => posts.push("timer"));
		vi.advanceTimersByTime(50);
		once.flush("spec-a", () => posts.push("pointer"));
		vi.advanceTimersByTime(500);
		expect(posts).toEqual(["pointer"]);
		expect(once.sentKey()).toBe("spec-a");
	});

	it("does not arm a second prepare for a spec that was already sent", () => {
		vi.useFakeTimers();
		const once = createPrepareOnce();
		const posts: string[] = [];
		once.flush("spec-a", () => posts.push("pointer"));
		once.arm("spec-a", 150, () => posts.push("timer"));
		vi.advanceTimersByTime(500);
		expect(posts).toEqual(["pointer"]);
	});

	it("keeps the 150 ms debounce for a later spec change", () => {
		vi.useFakeTimers();
		const once = createPrepareOnce();
		const posts: string[] = [];
		once.arm("spec-a", 150, () => posts.push("a"));
		vi.advanceTimersByTime(40);
		once.forgetIfDifferent("spec-b");
		once.arm("spec-b", 150, () => posts.push("b"));
		vi.advanceTimersByTime(149);
		expect(posts).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(posts).toEqual(["b"]);
	});

	it("can retry the failed key without forgetting a newer key", () => {
		const once = createPrepareOnce();
		const send = vi.fn();
		once.flush("a", send);
		once.forgetSent("old");
		expect(once.sentKey()).toBe("a");
		once.forgetSent("a");
		once.flush("a", send);
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("uses a stable key for the same spec value", () => {
		const spec = { start: 0, end: 12 };
		expect(prepareSpecKey(spec)).toBe(prepareSpecKey({ ...spec }));
	});
});

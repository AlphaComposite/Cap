// @vitest-environment jsdom

import type { Video } from "@cap/web-domain";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptSidebar } from "@/app/s/[videoId]/edit/TranscriptSidebar";

const mocks = vi.hoisted(() => ({
	getEditTranscript: vi.fn(),
	scrollToIndex: vi.fn(),
	staleSearch: false,
}));

vi.mock("react", async (importOriginal) => {
	const react = await importOriginal<typeof import("react")>();
	return {
		...react,
		useDeferredValue: (value: unknown) => {
			const deferred = react.useDeferredValue(value);
			return mocks.staleSearch && value === "between" ? "match" : deferred;
		},
	};
});

vi.mock("@/actions/videos/get-edit-transcript", () => ({
	getEditTranscript: mocks.getEditTranscript,
	requestEditTranscript: vi.fn(),
}));
vi.mock("@/app/s/[videoId]/edit/use-active-transcript-word-index", () => ({
	useActiveTranscriptWordIndex: () => -1,
}));
vi.mock("@cap/ui", () => ({ Switch: () => null }));
vi.mock("@virtual-grid/react", () => ({
	useVirtualizer: ({ count }: { count: number }) => ({
		getTotalSize: () => count * 100,
		getVirtualItems: () =>
			Array.from({ length: count }, (_, index) => ({
				index,
				key: index,
				start: index * 100,
			})),
		measureElement: vi.fn(),
		scrollToIndex: mocks.scrollToIndex,
	}),
}));

const transcript = {
	version: 3 as const,
	speechModelUsed: "synthetic",
	durationMs: 7_000,
	languageCode: "en",
	words: ["Match", "between", "matching", "other", "MATCH"].map(
		(text, index) => ({
			id: `word-${index}`,
			text,
			startMs: (index + 1) * 1_000,
			endMs: (index + 1) * 1_000 + 400,
			confidence: 1,
			speaker: null,
			channel: null,
		}),
	),
};

let container: HTMLDivElement;
let root: Root;
let video: HTMLVideoElement;

async function enterSearch(query: string, counter: string | null = "1/3") {
	const input = container.querySelector<HTMLInputElement>(
		'input[placeholder="Search transcript"]',
	);
	if (!input) throw new Error("Search input missing");
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, query);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	if (counter !== null) expect(container.textContent).toContain(counter);
	return input;
}

async function pressKey(key: string, shiftKey = false) {
	await act(async () => {
		container
			.querySelector("input")
			?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key, shiftKey }),
			);
	});
}

async function clickResult(direction: "Previous" | "Next") {
	const button = container.querySelector<HTMLButtonElement>(
		`button[aria-label="${direction} search result"]`,
	);
	if (!button) throw new Error("Search button missing");
	await act(async () => button.click());
}

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("No network"))),
	);
	HTMLElement.prototype.scrollIntoView = vi.fn();
	mocks.getEditTranscript.mockResolvedValue({ status: "ready", transcript });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	video = document.createElement("video");
	await act(async () => {
		root.render(
			createElement(TranscriptSidebar, {
				videoId: "synthetic-search" as Video.VideoId,
				videoRef: { current: video },
				keepRanges: [
					{ start: 1, end: 1.4 },
					{ start: 3, end: 7 },
				],
				autoCuts: {
					silence: {
						enabled: false,
						ranges: [],
						thresholdMs: 800,
						padMs: 150,
						removedMs: 0,
						gapCount: 0,
					},
					fillers: {
						enabled: false,
						ranges: [],
						mode: "ums",
						padMs: 80,
						removedCount: 0,
						skippedCount: 0,
					},
				},
				autoCutsInitialized: true,
				onDeleteRanges: vi.fn(),
				onRestoreRanges: vi.fn(),
				onSetAutoCutLayer: vi.fn(),
				onInitializeAutoCuts: vi.fn(),
			}),
		);
	});
});

afterEach(async () => {
	mocks.staleSearch = false;
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("transcript search navigation", () => {
	it("seeks the new query immediately even if deferred highlights lag", async () => {
		await enterSearch("match");
		mocks.staleSearch = true;
		await enterSearch("between", null);
		await pressKey("Enter");
		expect(video.currentTime).toBe(2);
	});
	it("starts forward at the first match, wraps, and keeps source time after cuts", async () => {
		await enterSearch("match");
		for (const [time, counter] of [
			[1, "1/3"],
			[3, "2/3"],
			[5, "3/3"],
			[1, "1/3"],
		] as const) {
			await pressKey("Enter");
			expect(video.currentTime).toBe(time);
			expect(container.textContent).toContain(counter);
		}
		expect(mocks.scrollToIndex).toHaveBeenCalled();
	});

	it.each(["button", "keyboard"])(
		"starts backward at the last match and wraps via %s",
		async (method) => {
			await enterSearch("match");
			for (const [time, counter] of [
				[5, "3/3"],
				[3, "2/3"],
				[1, "1/3"],
				[5, "3/3"],
			] as const) {
				if (method === "button") await clickResult("Previous");
				else await pressKey("Enter", true);
				expect(video.currentTime).toBe(time);
				expect(container.textContent).toContain(counter);
			}
		},
	);

	it("resets on query changes and Escape, handles one and zero matches", async () => {
		await enterSearch("between", "1/1");
		await clickResult("Next");
		expect(video.currentTime).toBe(2);
		await clickResult("Previous");
		expect(video.currentTime).toBe(2);
		await enterSearch("match");
		await clickResult("Next");
		expect(video.currentTime).toBe(1);
		await enterSearch("absent", "0/0");
		await pressKey("Enter");
		expect(video.currentTime).toBe(1);
		expect(
			container.querySelector<HTMLButtonElement>(
				'button[aria-label="Next search result"]',
			)?.disabled,
		).toBe(true);
		await pressKey("Escape");
		expect(container.querySelector("input")?.value).toBe("");
		await enterSearch("match");
		await clickResult("Previous");
		expect(video.currentTime).toBe(5);
	});
});

// @vitest-environment jsdom

import { act, createElement, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getTranscript: vi.fn(),
	requestTranscript: vi.fn(),
}));

vi.mock("@/actions/videos/get-edit-transcript", () => ({
	getEditTranscript: mocks.getTranscript,
	requestEditTranscript: mocks.requestTranscript,
}));
vi.mock("@/app/s/[videoId]/edit/use-active-transcript-word-index", () => ({
	useActiveTranscriptWordIndex: () => -1,
}));
vi.mock("@virtual-grid/react", () => ({
	useVirtualizer: ({ count }: { count: number }) => ({
		getTotalSize: () => count * 120,
		getVirtualItems: () =>
			Array.from({ length: count }, (_, index) => ({
				index,
				start: index * 120,
			})),
		measureElement: () => undefined,
		scrollToIndex: () => undefined,
	}),
}));
vi.mock("@cap/ui", async () => {
	const React = await import("react");
	return {
		Switch: (props: { checked?: boolean }) =>
			React.createElement("button", {
				type: "button",
				role: "switch",
				"aria-checked": props.checked,
			}),
	};
});
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

import { TranscriptSidebar } from "@/app/s/[videoId]/edit/TranscriptSidebar";
import { createIdentityEditSpec } from "@/lib/video-edits";

const transcript = {
	version: 3 as const,
	speechModelUsed: "universal",
	durationMs: 2_000,
	languageCode: "en",
	words: [
		{
			id: "final-word",
			text: "goodbye",
			startMs: 1_600,
			endMs: 1_900,
			confidence: 1,
			speaker: null,
			channel: null,
		},
	],
};

describe("transcript above the editor dock", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		mocks.getTranscript.mockResolvedValue({ status: "ready", transcript });
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		root.unmount();
		container.remove();
	});

	it("ends the sidebar above the measured dock and keeps the last word scrollable", async () => {
		const spec = createIdentityEditSpec(2);
		const videoRef: RefObject<HTMLVideoElement | null> = {
			current: document.createElement("video"),
		};
		await act(async () => {
			root.render(
				createElement(TranscriptSidebar, {
					videoId: "video-readability" as never,
					videoRef,
					keepRanges: spec.keepRanges,
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
					onDeleteRanges: () => undefined,
					onRestoreRanges: () => undefined,
					onSetAutoCutLayer: () => undefined,
					onInitializeAutoCuts: () => undefined,
				}),
			);
			await Promise.resolve();
		});

		const aside = container.querySelector("aside");
		expect(aside?.className ?? "").not.toContain("xl:h-[calc(100vh-6rem)]");
		expect(aside?.className ?? "").not.toContain("min-h-[36rem]");
		expect(aside?.className ?? "").toContain(
			"xl:bottom-[var(--editor-dock-height",
		);
		expect(aside?.className ?? "").toContain("xl:min-h-0");
		expect(aside?.textContent).toContain("goodbye");
		expect(container.querySelector(".overflow-y-auto")).not.toBeNull();

		const header = aside?.firstElementChild;
		const center = header?.nextElementSibling;
		const footer = aside?.lastElementChild;
		for (const className of [
			"min-h-0",
			"shrink",
			"basis-auto",
			"overflow-y-auto",
		]) {
			expect.soft(header?.classList.contains(className)).toBe(true);
		}
		expect.soft(header?.classList.contains("shrink-0")).toBe(false);
		for (const className of [
			"grow",
			"shrink-0",
			"basis-[8rem]",
			"min-h-[8rem]",
		]) {
			expect.soft(center?.classList.contains(className)).toBe(true);
		}
		for (const className of ["shrink-0", "basis-auto"]) {
			expect.soft(footer?.classList.contains(className)).toBe(true);
		}
		const scrollport = center?.firstElementChild;
		for (const className of ["h-full", "overflow-y-auto", "px-4", "py-4"]) {
			expect(scrollport?.classList.contains(className)).toBe(true);
		}
		expect(header?.querySelector("h2")?.textContent).toBe("Transcript");
		expect(header?.textContent).toContain("Original 0:02 · 1 words");
		expect(header?.querySelectorAll('[role="switch"]')).toHaveLength(2);
		expect(header?.textContent).toContain("Remove 1 no-speech pause");
		expect(header?.textContent).toContain("filler words");
		expect(footer?.textContent).toContain(
			"Select words to remove them from the video",
		);

		const search = header?.querySelector<HTMLInputElement>(
			'input[placeholder="Search transcript"]',
		);
		expect(search).not.toBeNull();
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(search, "goodbye");
			search?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(header?.textContent).toContain("1/1");
		for (const label of ["Previous search result", "Next search result"]) {
			const button = header?.querySelector<HTMLButtonElement>(
				`button[aria-label="${label}"]`,
			);
			expect(button).not.toBeNull();
			expect(button?.disabled).toBe(false);
		}
		expect(center?.firstElementChild).toBe(scrollport);
	});
});

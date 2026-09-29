// @vitest-environment jsdom

import { act, type RefObject } from "react";
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
		Switch: ({
			checked,
			onCheckedChange,
			...props
		}: {
			checked: boolean;
			onCheckedChange: (checked: boolean) => void;
			[key: string]: unknown;
		}) =>
			React.createElement("button", {
				...props,
				type: "button",
				role: "switch",
				"aria-checked": checked,
				onClick: () => onCheckedChange(!checked),
			}),
	};
});

import type { VideoAutoCuts, VideoEditRange } from "@cap/database/types";
import { TranscriptSidebar } from "@/app/s/[videoId]/edit/TranscriptSidebar";
import { planTranscriptCut } from "@/lib/edit-transcript";

const transcript = {
	version: 3 as const,
	speechModelUsed: "universal-3-5-pro",
	durationMs: 3_000,
	languageCode: "en",
	words: [
		{
			id: "hello",
			text: "hello",
			startMs: 0,
			endMs: 200,
			confidence: 1,
			speaker: null,
			channel: null,
		},
		{
			id: "there",
			text: "there",
			startMs: 1_200,
			endMs: 1_400,
			confidence: 1,
			speaker: null,
			channel: null,
		},
		{
			id: "world",
			text: "world",
			startMs: 2_400,
			endMs: 2_600,
			confidence: 1,
			speaker: null,
			channel: null,
		},
	],
};

function createAutoCuts(): VideoAutoCuts {
	return {
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
	};
}

function buttonLabels(container: HTMLElement) {
	return [...container.querySelectorAll("button")].map(
		(button) => button.textContent?.replace(/\s+/g, " ").trim() ?? "",
	);
}

function renderSidebar(
	root: Root,
	keepRanges: VideoEditRange[],
	onRestoreRanges: ReturnType<typeof vi.fn>,
	onDeleteRanges = vi.fn(),
) {
	const video = document.createElement("video");
	Object.defineProperty(video, "currentTime", {
		configurable: true,
		writable: true,
		value: 0,
	});
	const videoRef: RefObject<HTMLVideoElement | null> = { current: video };
	return act(async () => {
		root.render(
			(await import("react")).createElement(TranscriptSidebar, {
				videoId: "video-1" as never,
				videoRef,
				keepRanges,
				autoCuts: createAutoCuts(),
				autoCutsInitialized: true,
				onDeleteRanges,
				onRestoreRanges,
				onSetAutoCutLayer: vi.fn(),
				onInitializeAutoCuts: vi.fn(),
			}),
		);
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function selectWords(container: HTMLElement, start: number, end: number) {
	const startWord = container.querySelector<HTMLButtonElement>(
		`button[data-word-index="${start}"]`,
	);
	const endWord = container.querySelector<HTMLButtonElement>(
		`button[data-word-index="${end}"]`,
	);
	expect(startWord).not.toBeNull();
	expect(endWord).not.toBeNull();
	if (!startWord || !endWord) return;

	await act(async () => {
		startWord.dispatchEvent(
			new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
		);
	});
	if (end === start) return;
	await act(async () => {
		endWord.dispatchEvent(
			new MouseEvent("pointerdown", {
				bubbles: true,
				button: 0,
				shiftKey: true,
			}),
		);
	});
}

describe("transcript selection restore", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		mocks.getTranscript.mockResolvedValue({ status: "ready", transcript });
		mocks.requestTranscript.mockResolvedValue({
			status: "ready",
			transcript,
		});
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.clearAllMocks();
	});

	it("shows Restore 2 words for a deleted selection and restores the planned cut range", async () => {
		const onRestoreRanges = vi.fn();
		await renderSidebar(root, [{ start: 2, end: 3 }], onRestoreRanges);
		await selectWords(container, 0, 1);

		expect(
			buttonLabels(container).some((label) =>
				label.includes("Restore 2 words"),
			),
		).toBe(true);
		const restoreButton = [...container.querySelectorAll("button")].find(
			(button) => button.textContent?.includes("Restore 2 words"),
		);
		await act(async () => {
			restoreButton?.click();
		});

		const plan = planTranscriptCut(
			transcript.words,
			0,
			1,
			transcript.durationMs,
		);
		expect(plan).not.toBeNull();
		expect(onRestoreRanges).toHaveBeenCalledWith([
			{
				start: (plan?.startMs ?? 0) / 1000,
				end: (plan?.endMs ?? 0) / 1000,
			},
		]);
		expect(container.textContent).toContain(
			"Select words to remove them from the video",
		);
	});

	it("shows Delete and Restore side by side for a mixed selection", async () => {
		await renderSidebar(
			root,
			[
				{ start: 0, end: 1 },
				{ start: 2, end: 3 },
			],
			vi.fn(),
		);
		await selectWords(container, 0, 1);

		const labels = buttonLabels(container);
		expect(labels).toContain("Delete 1");
		expect(labels).toContain("Restore 1");
	});
});

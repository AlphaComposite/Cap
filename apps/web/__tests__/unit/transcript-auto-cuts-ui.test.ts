// @vitest-environment jsdom

import { act } from "react";
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

vi.mock("./use-active-transcript-word-index", () => ({
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

import type { VideoAutoCuts } from "@cap/database/types";
import { TranscriptSidebar } from "@/app/s/[videoId]/edit/TranscriptSidebar";

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
			id: "um",
			text: "um",
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

function renderSidebar(
	root: Root,
	autoCuts: VideoAutoCuts,
	onSetAutoCutLayer: ReturnType<typeof vi.fn>,
	onInitializeAutoCuts = vi.fn(),
	autoCutsInitialized?: boolean,
) {
	return act(async () => {
		root.render(
			// Avoid TSX because Vitest includes only *.test.ts files in this project.
			(await import("react")).createElement(TranscriptSidebar, {
				videoId: "video-1" as never,
				videoRef: { current: document.createElement("video") },
				keepRanges: [{ start: 0, end: 3 }],
				autoCuts,
				autoCutsInitialized,
				onDeleteRanges: vi.fn(),
				onSetAutoCutLayer,
				onInitializeAutoCuts,
			}),
		);
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("TranscriptSidebar automatic cuts", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		mocks.getTranscript.mockResolvedValue({ status: "ready", transcript });
		mocks.requestTranscript.mockResolvedValue({ status: "ready", transcript });
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.clearAllMocks();
	});

	it("exposes independent accessible toggles and emits source-timeline layers", async () => {
		const onSetAutoCutLayer = vi.fn();
		await renderSidebar(root, createAutoCuts(), onSetAutoCutLayer);

		const silenceSwitch = container.querySelector<HTMLButtonElement>(
			'button[role="switch"][aria-label="Remove 2 no-speech pauses (1.4s)"]',
		);
		const fillerSwitch = container.querySelector<HTMLButtonElement>(
			'button[role="switch"][aria-label="Remove 1 filler word"]',
		);
		expect(silenceSwitch).not.toBeNull();
		expect(fillerSwitch).not.toBeNull();

		await act(async () => silenceSwitch?.click());
		expect(onSetAutoCutLayer).toHaveBeenCalledWith(
			"silence",
			expect.objectContaining({
				enabled: true,
				gapCount: 2,
				removedMs: 1_400,
				ranges: [
					{ start: 0.35, end: 1.05 },
					{ start: 1.55, end: 2.25 },
				],
			}),
		);

		await act(async () => fillerSwitch?.click());
		expect(onSetAutoCutLayer).toHaveBeenCalledWith(
			"fillers",
			expect.objectContaining({
				enabled: true,
				removedCount: 1,
				ranges: [{ start: 1.12, end: 1.48 }],
			}),
		);
	});

	it("enables both automatic cut layers together when transcript timing first loads", async () => {
		const onInitializeAutoCuts = vi.fn();
		await renderSidebar(root, createAutoCuts(), vi.fn(), onInitializeAutoCuts);

		expect(onInitializeAutoCuts).toHaveBeenCalledOnce();
		expect(onInitializeAutoCuts).toHaveBeenCalledWith({
			silence: expect.objectContaining({
				enabled: true,
				gapCount: 2,
				removedMs: 1_400,
				ranges: [
					{ start: 0.35, end: 1.05 },
					{ start: 1.55, end: 2.25 },
				],
			}),
			fillers: expect.objectContaining({
				enabled: true,
				removedCount: 1,
				ranges: [{ start: 1.12, end: 1.48 }],
			}),
		});
	});

	it("does not re-enable explicitly disabled automatic cuts", async () => {
		const autoCuts = createAutoCuts();
		autoCuts.silence = {
			...autoCuts.silence,
			ranges: [{ start: 0.35, end: 1.05 }],
			removedMs: 700,
			gapCount: 1,
		};
		autoCuts.fillers = {
			...autoCuts.fillers,
			ranges: [{ start: 1.12, end: 1.48 }],
			removedCount: 1,
		};
		const onInitializeAutoCuts = vi.fn();

		await renderSidebar(root, autoCuts, vi.fn(), onInitializeAutoCuts);

		expect(onInitializeAutoCuts).not.toHaveBeenCalled();
	});

	it("does not re-enable initialized zero-candidate automatic cuts after reopening", async () => {
		mocks.getTranscript.mockResolvedValue({
			status: "ready",
			transcript: {
				...transcript,
				durationMs: 400,
				words: [
					{ ...transcript.words[0], startMs: 0, endMs: 200 },
					{ ...transcript.words[2], startMs: 200, endMs: 400 },
				],
			},
		});
		const onInitializeAutoCuts = vi.fn();

		await renderSidebar(
			root,
			createAutoCuts(),
			vi.fn(),
			onInitializeAutoCuts,
			true,
		);

		expect(onInitializeAutoCuts).not.toHaveBeenCalled();
	});

	it("shows live counts, pause chips, and permanent filler strikes", async () => {
		const autoCuts = createAutoCuts();
		autoCuts.silence = {
			...autoCuts.silence,
			enabled: true,
			removedMs: 1_400,
			gapCount: 2,
		};
		autoCuts.fillers = {
			...autoCuts.fillers,
			enabled: true,
			removedCount: 1,
		};
		await renderSidebar(root, autoCuts, vi.fn());

		expect(container.textContent).toContain("1.4s of no-speech pauses removed");
		expect(container.textContent).toContain("1 filler word removed");
		expect(container.textContent?.match(/1s/g)).toHaveLength(2);
		const fillerWord = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "um",
		);
		expect(fillerWord?.className).toContain("line-through");
	});

	it("shows leading and trailing silence chips", async () => {
		const edgeTranscript = {
			...transcript,
			durationMs: 4_100,
			words: [
				{ ...transcript.words[0], startMs: 1_000, endMs: 1_100 },
				{ ...transcript.words[1], startMs: 2_000, endMs: 2_100 },
				{ ...transcript.words[2], startMs: 3_000, endMs: 3_100 },
			],
		};
		mocks.getTranscript.mockResolvedValue({
			status: "ready",
			transcript: edgeTranscript,
		});
		const autoCuts = createAutoCuts();
		autoCuts.silence.enabled = true;
		await renderSidebar(root, autoCuts, vi.fn());

		expect(container.textContent?.match(/1s/g)).toHaveLength(2);
		expect(container.textContent?.match(/0\.9s/g)).toHaveLength(2);
	});

	it("does not strike filler words skipped for overlapping speech", async () => {
		const overlapTranscript = {
			...transcript,
			words: [
				{ ...transcript.words[0], startMs: 0, endMs: 500 },
				{ ...transcript.words[1], startMs: 200, endMs: 300 },
				{ ...transcript.words[2], startMs: 1_200, endMs: 1_400 },
			],
		};
		mocks.getTranscript.mockResolvedValue({
			status: "ready",
			transcript: overlapTranscript,
		});
		const autoCuts = createAutoCuts();
		autoCuts.fillers.enabled = true;
		await renderSidebar(root, autoCuts, vi.fn());

		const skippedFiller = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "um",
		);
		expect(skippedFiller?.className).not.toContain("line-through");
		expect(container.textContent).toContain("0 filler words removed");
	});

	it("does not show a false pause chip after overlapping speech", async () => {
		const overlapTranscript = {
			...transcript,
			durationMs: 1_400,
			words: [
				{ ...transcript.words[0], startMs: 0, endMs: 1_000 },
				{ ...transcript.words[1], startMs: 100, endMs: 200 },
				{ ...transcript.words[2], startMs: 1_200, endMs: 1_400 },
			],
		};
		mocks.getTranscript.mockResolvedValue({
			status: "ready",
			transcript: overlapTranscript,
		});
		const autoCuts = createAutoCuts();
		autoCuts.silence.enabled = true;
		await renderSidebar(root, autoCuts, vi.fn());

		expect(container.textContent).not.toContain("1s");
		expect(container.textContent).toContain("0s of no-speech pauses removed");
	});
});

// @vitest-environment jsdom

import { Blob as NodeBlob } from "node:buffer";
import type { VideoEditSpecV2 } from "@cap/database/types";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptionLanguage } from "@/app/s/[videoId]/_components/CaptionContext";
import { Transcript } from "@/app/s/[videoId]/_components/tabs/Transcript";
import type { VideoData } from "@/app/s/[videoId]/types";
import { deriveRevisionCaptions } from "@/lib/revision-publication-metadata";

const mocks = vi.hoisted(() => ({
	content: "",
	language: "original" as CaptionLanguage,
	currentVtt: null as string | null,
	edit: vi.fn(),
	seek: vi.fn(),
	createObjectURL: vi.fn<(blob: Blob) => string>(),
	revokeObjectURL: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/ui", () => ({ Button: () => null }));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useMutation: () => ({ isPending: false }),
}));
vi.mock("hooks/use-transcript", () => ({
	useTranscript: () => ({ data: mocks.content, isLoading: false }),
	useInvalidateTranscript: () => vi.fn(),
}));
vi.mock("hooks/use-live-transcript", () => ({
	useLiveTranscript: () => ({ data: null }),
}));
vi.mock("@/actions/videos/edit-transcript", () => ({
	editTranscriptEntry: mocks.edit,
}));
vi.mock("@/app/Layout/AuthContext", () => ({
	useCurrentUser: () => ({ id: "synthetic-owner" }),
}));
vi.mock("@/app/s/[videoId]/_components/CaptionContext", () => ({
	useCaptionContext: () => ({
		selectedLanguage: mocks.language,
		isTranslating: false,
		translatedVttContent: new Map(),
		currentVttContent: mocks.currentVtt,
	}),
}));

const published =
	"WEBVTT\n\n1\n00:00:01.001 --> 00:00:02.125\n日本語 café مرحبا\n\n2\n01:00:05.009 --> 01:00:10.250\nSecond cue\n\n3\n01:00:06.500 --> 01:00:07.750\nOverlapping final cue\n";
const video = {
	id: "synthetic-download",
	owner: { id: "synthetic-owner" },
	transcriptionStatus: "COMPLETE",
	createdAt: new Date(0),
} as VideoData;
let container: HTMLDivElement;
let root: Root;
let filenames: string[];

async function render() {
	await act(async () => {
		root.render(createElement(Transcript, { data: video, onSeek: mocks.seek }));
	});
}

async function click(selector: string) {
	const element = container.querySelector<HTMLButtonElement>(selector);
	if (!element) throw new Error(`Missing ${selector}`);
	await act(async () => element.click());
}

async function download() {
	await click('button[aria-label="Download transcript"]');
	const button = [...container.querySelectorAll("button")].find((element) =>
		element.textContent?.includes("Captions file"),
	);
	if (!button) throw new Error("Captions download missing");
	await act(async () => button.click());
	const blob = mocks.createObjectURL.mock.calls.at(-1)?.[0];
	if (!blob) throw new Error("Download blob missing");
	expect(blob.type).toBe("text/vtt");
	expect(mocks.revokeObjectURL).toHaveBeenCalledWith(
		"blob:synthetic-transcript",
	);
	return blob.text();
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("Blob", NodeBlob);
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("No network"))),
	);
	mocks.content = published;
	mocks.language = "original";
	mocks.currentVtt = null;
	mocks.edit.mockResolvedValue({ success: true });
	mocks.createObjectURL.mockReturnValue("blob:synthetic-transcript");
	Object.defineProperties(URL, {
		createObjectURL: { configurable: true, value: mocks.createObjectURL },
		revokeObjectURL: { configurable: true, value: mocks.revokeObjectURL },
	});
	filenames = [];
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		filenames.push(this.download);
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

describe("share transcript timed download", () => {
	it.each(["original", "ja"] as const)(
		"preserves published gaps, overlaps, final end and milliseconds for %s",
		async (language) => {
			mocks.language = language;
			mocks.currentVtt = published;
			await render();
			expect(await download()).toBe(published);
			expect(filenames).toEqual([
				`transcript-${video.id}${language === "original" ? "" : `.${language}`}.vtt`,
			]);
		},
	);

	it("preserves a single cue's final end via the canonical fallback", async () => {
		mocks.content = "WEBVTT\n\n1\n00:00:59.999 --> 00:01:00.001\nOnly cue\n";
		await render();
		expect(await download()).toBe(mocks.content);
	});

	it("keeps timings after an owner text edit", async () => {
		await render();
		await click('button[aria-label="Edit transcript entry"]');
		await act(async () => {
			const input = container.querySelector("textarea");
			if (!input) throw new Error("Editor missing");
			Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set?.call(input, "Edited caption");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const save = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Save",
		);
		if (!save) throw new Error("Save missing");
		await act(async () => save.click());
		expect(mocks.edit).toHaveBeenCalledWith(video.id, 1, "Edited caption");
		expect(await download()).toBe(
			published.replace("日本語 café مرحبا", "Edited caption"),
		);
	});

	it("downloads and seeks in the published output clock without remapping twice", async () => {
		const nextSpec: VideoEditSpecV2 = {
			version: 2,
			sourceDuration: 10,
			keepRanges: [{ start: 4, end: 8 }],
			manualKeepRanges: [{ start: 4, end: 8 }],
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
		};
		const { vtt } = deriveRevisionCaptions({
			transcript: {
				version: 3,
				speechModelUsed: "synthetic",
				durationMs: 10_000,
				languageCode: "en",
				words: [
					{
						id: "kept",
						text: "Kept.",
						startMs: 5_001,
						endMs: 5_125,
						confidence: 1,
						speaker: null,
						channel: null,
					},
				],
			},
			nextSpec,
		});
		expect(vtt).toContain("00:00:01.001 --> 00:00:01.125");
		mocks.content = vtt;
		await render();
		const cue = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Kept."),
		);
		if (!cue) throw new Error("Published cue missing");
		await act(async () => cue.click());
		expect(mocks.seek).toHaveBeenCalledWith(1.001);
		expect(await download()).toContain("00:00:01.001 --> 00:00:01.125\nKept.");
	});
});

// @vitest-environment jsdom

import { act, type ComponentProps, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "@/app/s/[videoId]/_components/tabs/Transcript";
import { createEditTranscript } from "@/lib/edit-transcript";
import { deriveRevisionCaptions } from "@/lib/revision-publication-metadata";
import {
	createTimelineStateFromEditSpec,
	getTimelineEditSpec,
} from "@/lib/video-edits";

const state = vi.hoisted(() => ({
	vtt: "",
	language: "original",
	copy: vi.fn(),
}));
vi.mock("@cap/ui", () => ({
	Button: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("hooks/use-transcript", () => ({
	useTranscript: () => ({ data: state.vtt, isLoading: false }),
	useInvalidateTranscript: () => vi.fn(),
}));
vi.mock("hooks/use-live-transcript", () => ({
	useLiveTranscript: () => ({ data: null }),
}));
vi.mock("@/actions/videos/edit-transcript", () => ({
	editTranscriptEntry: vi.fn(),
}));
vi.mock("@/app/Layout/AuthContext", () => ({ useCurrentUser: () => null }));
vi.mock("@/app/s/[videoId]/_components/CaptionContext", () => ({
	useCaptionContext: () => ({
		selectedLanguage: state.language,
		currentVttContent: state.vtt,
		isTranslating: false,
		availableTranslations: [],
		setSelectedLanguage: vi.fn(),
	}),
}));

const transcript = createEditTranscript(
	{
		words: [
			{ text: "Opening.", start: 0, end: 500, speaker: "A" },
			{ text: "Removed.", start: 1000, end: 1500, speaker: "B" },
			{ text: "Returning.", start: 2000, end: 2500, speaker: "A" },
			{ text: "Second.", start: 3250, end: 3500, speaker: "B" },
			{ text: "<v cap-speaker-C>literal</v>", start: 3600, end: 3900 },
		],
	},
	4000,
);
const spec = getTimelineEditSpec(
	createTimelineStateFromEditSpec({
		version: 1,
		sourceDuration: 4,
		keepRanges: [
			{ start: 0, end: 0.8 },
			{ start: 1.8, end: 4 },
		],
	}),
);
const data = {
	id: "speaker-ui",
	owner: { id: "owner" },
	source: { type: "webMP4" },
	metadata: {},
	transcriptionStatus: "COMPLETE",
	createdAt: new Date("2026-11-24T00:00:00Z"),
} as unknown as ComponentProps<typeof Transcript>["data"];
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	state.vtt = deriveRevisionCaptions({ transcript, nextSpec: spec }).vtt;
	state.language = "original";
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: state.copy },
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
async function render(onSeek = vi.fn()) {
	await act(async () =>
		root.render(createElement(Transcript, { data, onSeek })),
	);
	return onSeek;
}
function button(label: string) {
	const target = Array.from(container.querySelectorAll("button")).find(
		(value) => value.textContent?.includes(label),
	);
	if (!target) throw new Error(`button missing: ${label}`);
	return target;
}

describe("offline Transcript speaker display", () => {
	it("downloads marked text without reinterpreting tags or double-escaped entities", async () => {
		state.vtt =
			"WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n<v cap-speaker-A>&amp;amp; &lt;v cap-speaker-B&gt;literal&lt;/v&gt;</v>\n\n";
		let download: Blob | null = null;
		vi.stubGlobal("URL", {
			createObjectURL: (blob: Blob) => {
				download = blob;
				return "blob:offline";
			},
			revokeObjectURL: vi.fn(),
		});
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		await render();
		await act(async () =>
			container
				.querySelector<HTMLButtonElement>(
					'button[aria-label="Download transcript"]',
				)
				?.click(),
		);
		await act(async () => button("Captions file").click());
		expect(download).not.toBeNull();
		const text = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result));
			reader.onerror = () => reject(reader.error);
			reader.readAsText(download as unknown as Blob);
		});
		expect(text).toContain(
			"<c.cap-text>&amp;amp; &lt;v cap-speaker-B&gt;literal&lt;/v&gt;</c>",
		);
		expect(text).not.toContain("<v cap-speaker-");
	});

	it("renders labels at turns, preserves literal text, and seeks on the edited clock after reload", async () => {
		const seek = await render();
		expect(container.textContent).toContain("Speaker A");
		expect(container.textContent?.match(/Speaker A/g)).toHaveLength(1);
		expect(container.textContent).toContain("Speaker B");
		expect(container.textContent).not.toContain("Speaker C");
		expect(container.textContent).not.toContain("Removed.");
		expect(container.textContent).toContain("<v cap-speaker-C>literal</v>");
		expect(container.querySelector("v")).toBeNull();
		await act(async () => button("Second.").click());
		expect(seek).toHaveBeenLastCalledWith(2.25);
		await act(async () => root.unmount());
		root = createRoot(container);
		const afterReload = await render();
		await act(async () => button("Second.").click());
		expect(afterReload).toHaveBeenLastCalledWith(2.25);
		expect(container.textContent).toContain("Speaker B");
	});

	it("never treats translated annotations as source attribution", async () => {
		state.language = "fr";
		await render();
		expect(container.textContent).not.toContain("Speaker A");
		expect(container.textContent).not.toContain("Speaker B");
		expect(container.textContent).toContain("Opening.");
	});

	it("copies plain text without structured labels or tags", async () => {
		await render();
		const menu = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Copy transcript"]',
		);
		expect(menu).not.toBeNull();
		await act(async () => menu?.click());
		await act(async () => button("Formatted text").click());
		expect(state.copy).toHaveBeenCalledOnce();
		const copied = state.copy.mock.calls[0]?.[0] as string;
		expect(copied).toContain("Opening.");
		expect(copied).not.toContain("Speaker A");
		expect(copied).not.toContain("cap-speaker-A");
		expect(copied).toContain("<v cap-speaker-C>literal</v>");
	});
});

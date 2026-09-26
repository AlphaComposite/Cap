// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { toast } from "sonner";
import { EditVideoClient } from "@/app/s/[videoId]/edit/EditVideoClient";
import {
	getTimelineDraftKey,
	writeTimelineDraft,
} from "@/lib/video-edit-drafts";
import {
	createIdentityEditSpec,
	createTimelineStateFromEditSpec,
	getTimelineSegments,
	normalizeKeepRanges,
	selectTimelineSegment,
} from "@/lib/video-edits";

const harness = vi.hoisted(() => ({
	post: vi.fn(),
	instant: vi.fn(),
	push: vi.fn(),
	refresh: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: harness.push,
		refresh: harness.refresh,
		replace: vi.fn(),
	}),
}));

vi.mock("@/actions/videos/download", () => ({
	getVideoDownloadInfo: vi.fn(),
}));

vi.mock("@/actions/videos/publish-revision", () => ({
	getEditorInstantFinishState: (...args: unknown[]) => harness.instant(...args),
}));

vi.mock("@/actions/videos/save-edits", () => ({
	restoreVideoToOriginal: vi.fn(),
	saveVideoEdits: vi.fn(),
}));

vi.mock("@/utils/view-transition", () => ({
	navigateWithTransition: vi.fn(),
}));

vi.mock("@/lib/revision-publish-client", () => ({
	postRevisionRoute: (...args: unknown[]) => harness.post(...args),
}));

vi.mock("@/lib/instant-finish-playback-handoff", () => ({
	prefetchInstantFinishPlaylist: vi.fn(),
	stashInstantFinishPlayback: vi.fn(),
}));

vi.mock("@cap/ui", async () => {
	const React = await import("react");
	const Button = ({
		children,
		onClick,
		disabled,
	}: {
		children?: ReactNode;
		onClick?: () => void;
		disabled?: boolean;
	}) =>
		React.createElement(
			"button",
			{ type: "button", onClick, disabled },
			children,
		);
	const Wrapper = ({ children }: { children?: ReactNode }) =>
		React.createElement(React.Fragment, null, children);
	return {
		Button,
		Dialog: Wrapper,
		DialogContent: Wrapper,
		DialogDescription: Wrapper,
		DialogFooter: Wrapper,
		DialogHeader: Wrapper,
		DialogTitle: Wrapper,
	};
});

vi.mock("@/app/s/[videoId]/_components/CapVideoPlayer", async () => {
	const React = await import("react");
	return {
		CapVideoPlayer: () =>
			React.createElement("video", { "data-editor-preview": "true" }),
	};
});

vi.mock("@/app/s/[videoId]/_components/VideoDownloadMenu", () => ({
	VideoDownloadMenu: () => null,
}));

vi.mock("@/app/s/[videoId]/_components/video-frame-thumbnail", () => ({
	captureVideoFrameDataUrl: vi.fn(),
}));

vi.mock("@/app/s/[videoId]/edit/EditorChapterPreview", () => ({
	EditorChapterMarkers: () => null,
	useEditorChapterPreview: () => ({ chaptersUrl: null, projectedChapters: [] }),
}));

vi.mock("@/app/s/[videoId]/edit/TranscriptSidebar", async () => {
	const React = await import("react");
	return {
		TranscriptSidebar: () =>
			React.createElement("aside", { "data-transcript-sidebar": "true" }),
	};
});

vi.mock("@/app/s/[videoId]/edit/use-renewing-playback-source", () => ({
	useRenewingPlaybackSource: ({ initialSrc }: { initialSrc: string }) =>
		initialSrc,
}));

const VIDEO_ID = "video-1";
const DURATION = 10;

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let container: HTMLDivElement;
let root: Root;
let rejectPublish: (error: unknown) => void;

function seedDraft() {
	const baseline = createIdentityEditSpec(DURATION);
	const cut = createTimelineStateFromEditSpec(
		normalizeKeepRanges(
			[
				{ start: 0, end: 4 },
				{ start: 6, end: DURATION },
			],
			DURATION,
		),
	);
	const segment = getTimelineSegments(cut).find((item) => !item.deleted);
	if (!segment) throw new Error("missing kept segment");
	const selected = selectTimelineSegment(cut, segment.id);
	writeTimelineDraft(
		localStorage,
		getTimelineDraftKey(VIDEO_ID),
		DURATION,
		selected,
		baseline,
	);
	return { baseline, selectedSegmentId: segment.id };
}

async function flush() {
	await act(async () => {
		await Promise.resolve();
	});
}

async function renderEditor(
	baseline: ReturnType<typeof createIdentityEditSpec>,
) {
	await act(async () => {
		root.render(
			createElement(EditVideoClient, {
				video: {
					id: VIDEO_ID as never,
					name: "Timing fixture",
					ownerId: "owner-1",
					duration: DURATION,
					width: 1920,
					height: 1080,
					transcriptionStatus: "COMPLETE",
				},
				chapters: [],
				hasExistingEdits: false,
				initialEditSpec: baseline,
				playbackSrc: "/original.mp4",
				usesOriginalSource: false,
			}),
		);
	});
	for (let attempt = 0; attempt < 20; attempt++) {
		const done = doneButton();
		if (
			done &&
			!done.disabled &&
			container.textContent?.includes("Edited") &&
			container.querySelector("[data-trim-handle]")
		) {
			return done;
		}
		await flush();
	}
	throw new Error(`editor did not hydrate: ${container.textContent}`);
}

function doneButton() {
	return [...container.querySelectorAll("button")].find(
		(element) => element.textContent === "Done",
	);
}

function storedDraft() {
	const raw = localStorage.getItem(getTimelineDraftKey(VIDEO_ID));
	if (!raw) return null;
	return JSON.parse(raw) as {
		state: { selectedSegmentId: string | null; deletedRanges: unknown };
	};
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("ResizeObserver", ResizeObserverStub);
	localStorage.clear();
	harness.post.mockReset();
	harness.instant.mockReset();
	harness.push.mockReset();
	harness.refresh.mockReset();
	vi.mocked(toast.error).mockReset();
	harness.instant.mockResolvedValue({
		enabled: true,
		generation: 3,
		draftVersion: 1,
	});
	let resolvePublish: (value: unknown) => void = () => {};
	rejectPublish = () => {};
	const pending = new Promise((resolve, reject) => {
		resolvePublish = resolve;
		rejectPublish = reject;
	});
	void resolvePublish;
	harness.post.mockImplementation((path: string) => {
		if (String(path).endsWith("/prepare")) {
			return Promise.resolve({ revisionId: "prepared", generation: 4 });
		}
		return pending;
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

describe("editor publish unmount", () => {
	it("renders the publishing placeholder and unmounts the timeline before publish resolves", async () => {
		const { baseline } = seedDraft();
		const done = await renderEditor(baseline);
		expect(
			container.querySelectorAll("[data-trim-handle]").length,
		).toBeGreaterThan(0);
		expect(container.querySelector("video")).not.toBeNull();
		expect(container.querySelector("[data-transcript-sidebar]")).not.toBeNull();

		await act(async () => {
			done.click();
		});

		expect(
			container
				.querySelector("[data-editor-shell]")
				?.getAttribute("data-editor-shell"),
		).toBe("publishing");
		expect(container.textContent).toContain("Saving / Publishing");
		expect(container.querySelector("[data-trim-handle]")).toBeNull();
		expect(container.querySelector("[data-editor-shell='editor']")).toBeNull();
		expect(container.querySelector("video")).toBeNull();
		expect(container.querySelector("[data-transcript-sidebar]")).toBeNull();
		expect(harness.post).toHaveBeenCalledWith(
			"/api/video/revision/publish",
			expect.objectContaining({ videoId: VIDEO_ID }),
		);
		expect(harness.push).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "409",
			error: Object.assign(new Error("generation mismatch"), { status: 409 }),
			toast: "A newer draft exists. Retry Done.",
		},
		{
			name: "500",
			error: Object.assign(new Error("Request failed"), { status: 500 }),
			toast: "Request failed",
		},
		{
			name: "abort",
			error: new DOMException("The operation was aborted.", "AbortError"),
			toast: "The operation was aborted.",
		},
	])(
		"restores cuts, selection, and draft after $name",
		async ({ error, toast: toastMessage }) => {
			const { baseline, selectedSegmentId } = seedDraft();
			const done = await renderEditor(baseline);
			const cutsBefore =
				container.querySelectorAll("[data-trim-handle]").length;
			expect(storedDraft()?.state.selectedSegmentId).toBe(selectedSegmentId);
			expect(container.textContent).toContain("0:08");

			await act(async () => {
				done.click();
			});
			expect(container.textContent).toContain("Saving / Publishing");
			expect(harness.push).not.toHaveBeenCalled();

			await act(async () => {
				rejectPublish(error);
			});

			expect(
				container.querySelector("[data-editor-shell='editor']"),
			).not.toBeNull();
			expect(container.textContent).not.toContain("Saving / Publishing");
			expect(container.querySelectorAll("[data-trim-handle]").length).toBe(
				cutsBefore,
			);
			expect(container.textContent).toContain("Edited");
			expect(container.textContent).toContain("0:08");
			expect(storedDraft()?.state.selectedSegmentId).toBe(selectedSegmentId);
			expect(doneButton()?.disabled).toBe(false);
			expect(toast.error).toHaveBeenCalledWith(toastMessage);
			expect(harness.push).not.toHaveBeenCalled();
		},
	);
});

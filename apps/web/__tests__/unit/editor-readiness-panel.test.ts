// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveEditReadiness } from "../../lib/video-edit-readiness";
import { createIdentityEditSpec } from "../../lib/video-edits";

const mocks = vi.hoisted(() => ({
	readiness: vi.fn(),
	sidebar: vi.fn(),
	refresh: vi.fn(),
	check: vi.fn(),
	prepare: vi.fn(),
}));
vi.mock("../../hooks/use-edit-readiness", () => ({
	useEditReadiness: mocks.readiness,
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }),
}));
vi.mock("@/actions/videos/download", () => ({ getVideoDownloadInfo: vi.fn() }));
vi.mock("@/actions/videos/get-edit-transcript", () => ({
	requestEditTranscript: mocks.prepare,
}));
vi.mock("@/actions/videos/publish-revision", () => ({
	getEditorInstantFinishState: async () => ({
		enabled: false,
		generation: 0,
		draftVersion: 0,
		draftSession: "",
	}),
}));
vi.mock("@/actions/videos/save-edits", () => ({
	restoreVideoToOriginal: vi.fn(),
	saveVideoEdits: vi.fn(),
}));
vi.mock("@/app/s/[videoId]/_components/CapVideoPlayer", () => ({
	CapVideoPlayer: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/VideoDownloadMenu", () => ({
	VideoDownloadMenu: () => null,
}));
vi.mock("@/app/s/[videoId]/edit/TranscriptSidebar", async () => {
	const React = await import("react");
	return {
		TranscriptSidebar: () => {
			mocks.sidebar();
			return React.createElement("aside", null, "Usable transcript controls");
		},
	};
});
vi.mock("@/app/s/[videoId]/edit/EditorChapterPreview", () => ({
	EditorChapterMarkers: () => null,
	useEditorChapterPreview: () => ({}),
}));
vi.mock("@cap/ui", async () => {
	const React = await import("react");
	const wrapper = ({ children }: { children?: ReactNode }) =>
		React.createElement("div", null, children);
	return {
		Button: ({
			children,
			disabled,
			onClick,
		}: {
			children?: ReactNode;
			disabled?: boolean;
			onClick?: () => void;
		}) => React.createElement("button", { disabled, onClick }, children),
		...Object.fromEntries(
			[
				"Dialog",
				"DialogContent",
				"DialogDescription",
				"DialogFooter",
				"DialogHeader",
				"DialogTitle",
			].map((name) => [name, wrapper]),
		),
	};
});

import { EditReadinessGate } from "../../app/s/[videoId]/edit/EditReadinessGate";
import { EditVideoClient } from "../../app/s/[videoId]/edit/EditVideoClient";

let root: Root;
let element: HTMLDivElement;
const state = (status: string | null, usable = false) => ({
	readiness: deriveEditReadiness({
		videoId: "video",
		identity: "current",
		eligible: true,
		isPro: true,
		playbackAdmission: true,
		videoState: "processed",
		transcriptionStatus: status,
		transcriptRead: usable ? "ready" : "unavailable",
	}),
	checking: false,
	message: "",
	checkAgain: mocks.check,
});
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: false })),
	);
	element = document.createElement("div");
	root = createRoot(element);
	mocks.readiness.mockReturnValue(state("PROCESSING"));
	mocks.prepare.mockResolvedValue({ status: "processing" });
});
afterEach(async () => {
	await act(async () => root.unmount());
	vi.unstubAllGlobals();
});
async function editor() {
	await act(async () =>
		root.render(
			createElement(EditVideoClient, {
				video: {
					id: "video",
					ownerId: "owner",
					name: "Synthetic",
					duration: 20,
					width: 100,
					height: 100,
					transcriptionStatus: "PROCESSING",
				},
				chapters: [],
				hasExistingEdits: false,
				initialEditSpec: createIdentityEditSpec(20),
				playbackSrc: "",
				usesOriginalSource: false,
			} as never),
		),
	);
}
describe("editor readiness panel", () => {
	it("preserves explicit canonical word-timing preparation without polling mutations", async () => {
		mocks.readiness.mockReturnValue(state("COMPLETE"));
		await editor();
		expect(mocks.prepare).not.toHaveBeenCalled();
		const button = [...element.querySelectorAll("button")].find(
			(node) => node.textContent === "Prepare word timings",
		);
		expect(button).toBeTruthy();
		await act(async () => button?.click());
		expect(mocks.prepare).toHaveBeenCalledWith("video");
		expect(mocks.check).toHaveBeenCalledOnce();
	});
	it.each([null, "PROCESSING", "ERROR", "SKIPPED", "NO_AUDIO", "COMPLETE"])(
		"shows explanatory status and keeps manual timeline for nonusable %s",
		async (status) => {
			mocks.readiness.mockReturnValue(state(status));
			await editor();
			expect(mocks.sidebar).not.toHaveBeenCalled();
			expect(element.textContent).toContain(
				state(status).readiness.transcriptLabel,
			);
			expect(
				element.querySelector('button[aria-label="Split at playhead"]') ??
					[...element.querySelectorAll("button")].find((button) =>
						button.textContent?.includes("Split"),
					),
			).toBeTruthy();
		},
	);
	it("mounts usable sidebar after the read transition without reopening the editor", async () => {
		await editor();
		expect(mocks.sidebar).not.toHaveBeenCalled();
		mocks.readiness.mockReturnValue(state("COMPLETE", true));
		await editor();
		expect(element.textContent).toContain("Usable transcript controls");
		expect(mocks.refresh).not.toHaveBeenCalled();
	});
	it("Check again in preparation only reads, never navigates automatically", async () => {
		await act(async () =>
			root.render(
				createElement(EditReadinessGate, { videoId: "video" as never }),
			),
		);
		const button = [...element.querySelectorAll("button")].find(
			(node) => node.textContent === "Check again",
		);
		await act(async () => button?.click());
		expect(mocks.check).toHaveBeenCalledOnce();
		expect(mocks.refresh).not.toHaveBeenCalled();
	});
});

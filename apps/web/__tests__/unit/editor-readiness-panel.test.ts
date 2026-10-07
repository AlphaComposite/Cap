// @vitest-environment jsdom
import { act, createElement, type ReactNode, StrictMode } from "react";
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
	useEditorChapterPreview: () => ({ playbackChapters: [] }),
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
	sessionStorage.clear();
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
	it("Check again only rechecks and does not itself navigate", async () => {
		await act(async () =>
			root.render(
				createElement(EditReadinessGate, { videoId: "video" as never }),
			),
		);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		const button = [...element.querySelectorAll("button")].find(
			(node) => node.textContent === "Check again",
		);
		await act(async () => button?.click());
		expect(mocks.check).toHaveBeenCalledOnce();
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
	});
	function gateState(
		manual: boolean,
		identity = manual ? "admitted" : "pending",
	) {
		return {
			readiness: deriveEditReadiness({
				videoId: "video",
				identity,
				eligible: true,
				isPro: true,
				playbackAdmission: manual,
				videoState: manual ? "processed" : "processing",
				transcriptionStatus: "PROCESSING",
				transcriptRead: "unavailable",
			}),
			checking: false,
			message: "",
			checkAgain: mocks.check,
		};
	}
	it("refreshes the server page once when manual admission appears", async () => {
		mocks.readiness.mockReturnValue(gateState(false));
		await act(async () =>
			root.render(
				createElement(EditReadinessGate, { videoId: "video" as never }),
			),
		);
		expect(mocks.refresh).not.toHaveBeenCalled();
		mocks.readiness.mockReturnValue(gateState(true));
		await act(async () =>
			root.render(
				createElement(EditReadinessGate, { videoId: "video" as never }),
			),
		);
		expect(element.textContent).toContain("Open timeline editor");
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
	});
	async function renderGate(videoId = "video") {
		await act(async () =>
			root.render(
				createElement(EditReadinessGate, { videoId: videoId as never }),
			),
		);
	}
	it("refreshes once per admission identity and keeps explicit retry", async () => {
		mocks.readiness.mockReturnValue(gateState(false));
		await renderGate();
		mocks.readiness.mockReturnValue({
			readiness: null,
			checking: false,
			message: "Unable to check readiness",
			checkAgain: mocks.check,
		});
		await renderGate();
		expect(mocks.refresh).not.toHaveBeenCalled();
		mocks.readiness.mockReturnValue(gateState(true, "admitted"));
		await renderGate();
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		await renderGate();
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		mocks.readiness.mockReturnValue(gateState(true, "changed"));
		await renderGate();
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		const open = [...element.querySelectorAll("button")].find(
			(node) => node.textContent === "Open timeline editor",
		);
		await act(async () => open?.click());
		expect(mocks.refresh).toHaveBeenCalledTimes(3);
		const check = [...element.querySelectorAll("button")].find(
			(node) => node.textContent === "Check again",
		);
		await act(async () => check?.click());
		expect(mocks.check).toHaveBeenCalledOnce();
		expect(mocks.refresh).toHaveBeenCalledTimes(3);
	});
	it("does not refresh stale, switched, or unmounted gate readiness", async () => {
		mocks.readiness.mockReturnValue(gateState(false));
		await renderGate();
		const stale = gateState(true, "other-page");
		stale.readiness = { ...stale.readiness, videoId: "other" };
		mocks.readiness.mockReturnValue(stale);
		await renderGate("next");
		expect(mocks.refresh).not.toHaveBeenCalled();
		await act(async () => root.render(null));
		mocks.readiness.mockReturnValue(gateState(true));
		expect(mocks.refresh).not.toHaveBeenCalled();
	});
	function readinessFor(videoId: string, manual: boolean, identity: string) {
		const next = gateState(manual, identity);
		return {
			...next,
			readiness: { ...next.readiness, videoId },
		};
	}
	it("refreshes once when the first mounted readiness is already manual", async () => {
		mocks.readiness.mockReturnValue(gateState(true, "first-ready"));
		await renderGate();
		expect(element.textContent).toContain("Open timeline editor");
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		const open = [...element.querySelectorAll("button")].find(
			(node) => node.textContent === "Open timeline editor",
		);
		await act(async () => open?.click());
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		const check = [...element.querySelectorAll("button")].find(
			(node) => node.textContent === "Check again",
		);
		await act(async () => check?.click());
		expect(mocks.check).toHaveBeenCalledOnce();
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
	});
	it("refreshes once from an initial unavailable read to manual ready", async () => {
		mocks.readiness.mockReturnValue({
			readiness: null,
			checking: true,
			message: "Checking readiness",
			checkAgain: mocks.check,
		});
		await renderGate();
		expect(mocks.refresh).not.toHaveBeenCalled();
		mocks.readiness.mockReturnValue(gateState(true, "became-ready"));
		await renderGate();
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		await renderGate();
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
	});
	it("does not repeat refresh for a stable identity across rerender, remount, or StrictMode", async () => {
		mocks.readiness.mockReturnValue(gateState(true, "stable-ready"));
		await renderGate();
		await renderGate();
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
		root = createRoot(element);
		await renderGate();
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
		root = createRoot(element);
		sessionStorage.clear();
		mocks.refresh.mockClear();
		await act(async () =>
			root.render(
				createElement(
					StrictMode,
					null,
					createElement(EditReadinessGate, { videoId: "video" as never }),
				),
			),
		);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
	});
	it("isolates automatic reentry by video and identity and does not refresh after unmount", async () => {
		mocks.readiness.mockReturnValue(
			readinessFor("video-a", true, "shared-identity"),
		);
		await renderGate("video-a");
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		mocks.readiness.mockReturnValue(
			readinessFor("video-b", true, "shared-identity"),
		);
		await renderGate("video-b");
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		mocks.readiness.mockReturnValue(
			readinessFor("video-a", true, "shared-identity"),
		);
		await renderGate("video-a");
		expect(mocks.refresh).toHaveBeenCalledTimes(2);
		mocks.readiness.mockReturnValue(
			readinessFor("video-a", true, "changed-identity"),
		);
		await renderGate("video-a");
		expect(mocks.refresh).toHaveBeenCalledTimes(3);
		mocks.readiness.mockReturnValue(
			readinessFor("video-b", true, "shared-identity"),
		);
		await renderGate("video-a");
		expect(mocks.refresh).toHaveBeenCalledTimes(3);
		await act(async () => root.unmount());
		root = createRoot(element);
		expect(mocks.refresh).toHaveBeenCalledTimes(3);
	});
});

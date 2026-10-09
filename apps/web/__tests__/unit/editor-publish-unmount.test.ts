// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/actions/videos/get-edit-transcript", () => ({
	requestEditTranscript: vi.fn(),
}));
vi.mock("../../hooks/use-edit-readiness", () => ({
	useEditReadiness: () => ({
		readiness: { transcriptUsable: true },
		checkAgain: () => {},
	}),
}));
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
	expectedEditFenceMatches,
	getTimelineEditSpec,
	getTimelineSegments,
	normalizeKeepRanges,
	selectTimelineSegment,
} from "@/lib/video-edits";

const harness = vi.hoisted(() => ({
	post: vi.fn(),
	instant: vi.fn(),
	rewarm: vi.fn(),
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

vi.mock("@/actions/videos/get-edit-transcript", () => ({
	requestEditTranscript: vi.fn(),
}));

vi.mock("../../hooks/use-edit-readiness", () => ({
	useEditReadiness: () => ({
		readiness: { transcriptUsable: true },
		checking: false,
		message: "",
		checkAgain: vi.fn(),
	}),
}));

vi.mock("@/actions/videos/publish-revision", () => ({
	getEditorInstantFinishState: (...args: unknown[]) => harness.instant(...args),
	rewarmEditorSource: (...args: unknown[]) => harness.rewarm(...args),
}));

vi.mock("@/actions/videos/save-edits", () => ({
	restoreVideoToOriginal: vi.fn(),
	saveVideoEdits: vi.fn(),
}));

vi.mock("@/utils/view-transition", () => ({
	navigateWithTransition: vi.fn(),
}));

vi.mock("@/lib/revision-publish-client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/revision-publish-client")>()),
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
	useEditorChapterPreview: () => ({
		chaptersUrl: null,
		playbackChapters: [],
		projectedChapters: [],
	}),
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

function seedDraft(baseline = createIdentityEditSpec(DURATION)) {
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

function editorElement(baseline: ReturnType<typeof createIdentityEditSpec>) {
	return createElement(EditVideoClient, {
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
	});
}

async function renderEditor(
	baseline: ReturnType<typeof createIdentityEditSpec>,
) {
	await act(async () => {
		root.render(editorElement(baseline));
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
	harness.rewarm.mockReset();
	harness.rewarm.mockResolvedValue({ success: true });
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
	it.each(["same session", "same session within tolerance", "other session"])(
		"refreshes the worker baseline after privacy refusals: %s",
		async (session) => {
			const { baseline } = seedDraft();
			const draftSession = "this-editor-session";
			localStorage.setItem(`cap:edit-draft-session:${VIDEO_ID}`, draftSession);
			const done = await renderEditor(baseline);
			const workerSpec = getTimelineEditSpec(
				createTimelineStateFromEditSpec(baseline),
			);
			if (session === "same session within tolerance") {
				workerSpec.keepRanges = [{ start: 0.001, end: DURATION }];
				workerSpec.manualKeepRanges = workerSpec.keepRanges;
			}
			expect(expectedEditFenceMatches(workerSpec, baseline)).toBe(false);
			harness.instant.mockResolvedValue({
				enabled: true,
				generation: 3,
				draftVersion: 2,
				draftSession: session.startsWith("same session")
					? draftSession
					: "another-session",
				expectedEditSpec: workerSpec,
			});
			vi.useFakeTimers();
			let attempts = 0;
			harness.post.mockImplementation(async (path: string, body) => {
				if (path.endsWith("/prepare")) return { generation: 3 };
				if (++attempts <= 5)
					throw Object.assign(
						new Error(
							"Finish refused until source relocation is PURGED and liveKey is the relocated key",
						),
						{ status: 409 },
					);
				if (!expectedEditFenceMatches(workerSpec, body.expectedEditSpec))
					throw Object.assign(
						new Error(
							"This video was edited in another session. Reload before publishing.",
						),
						{ status: 409 },
					);
				return { success: true, revisionId: "latest-local-cut", generation: 4 };
			});
			try {
				await act(async () => done.click());
				const savedDraft = localStorage.getItem(getTimelineDraftKey(VIDEO_ID));
				expect(container.querySelector("output")?.textContent).toContain(
					"Waiting for source privacy checks",
				);
				await act(async () => {
					await vi.advanceTimersByTimeAsync(5_000);
				});
				const publishes = harness.post.mock.calls.filter(([path]) =>
					path.endsWith("/publish"),
				);
				if (session.startsWith("same session")) {
					expect(publishes).toHaveLength(7);
					expect(publishes[6]?.[1]).toEqual({
						...publishes[0]?.[1],
						expectedEditSpec: workerSpec,
						draftVersion: 3,
						expectedDraftSession: draftSession,
					});
					expect(publishes[6]?.[1].editSpec.keepRanges).toEqual([
						{ start: 0, end: 4 },
						{ start: 6, end: 10 },
					]);
					expect(harness.push).toHaveBeenCalledExactlyOnceWith(
						`/s/${VIDEO_ID}`,
					);
					expect(storedDraft()).toBeNull();
					expect(toast.error).not.toHaveBeenCalled();
				} else {
					expect(publishes).toHaveLength(6);
					expect(harness.push).not.toHaveBeenCalled();
					expect(localStorage.getItem(getTimelineDraftKey(VIDEO_ID))).toBe(
						savedDraft,
					);
					expect(toast.error).toHaveBeenCalledWith(
						"This video was edited in another session. Reload before publishing.",
					);
				}
			} finally {
				vi.useRealTimers();
			}
		},
	);
	it("keeps the baseline fence when a rejected A publish reclaims B's session", async () => {
		const { baseline, selectedSegmentId } = seedDraft();
		localStorage.setItem(`cap:edit-draft-session:${VIDEO_ID}`, "A");
		harness.instant.mockResolvedValue({
			enabled: true,
			generation: 3,
			draftVersion: 0,
		});
		const done = await renderEditor(baseline);
		const savedDraft = localStorage.getItem(getTimelineDraftKey(VIDEO_ID));
		const publishedB = getTimelineEditSpec(
			createTimelineStateFromEditSpec(
				normalizeKeepRanges([{ start: 2, end: 9 }], DURATION),
			),
		);
		let current = baseline;
		let serverDraftSession = "";
		let serverDraftVersion = 0;
		let generation = 3;
		let attempts = 0;
		let acceptedPublishes = 0;
		harness.instant.mockImplementation(async () => {
			expect(serverDraftSession).toBe("A");
			expect(serverDraftVersion).toBe(1);
			expect(current).toBe(publishedB);
			return {
				enabled: true,
				generation,
				draftVersion: serverDraftVersion,
				draftSession: serverDraftSession,
				expectedEditSpec: current,
			};
		});
		harness.post.mockImplementation(async (path: string, body) => {
			if (path.endsWith("/prepare")) return { generation: 3 };
			if (attempts === 1) {
				expect(serverDraftSession).toBe("B");
				expect(body.draftVersion).toBe(serverDraftVersion);
			}
			// recordServerDraft accepts equal versions and records A before the spec fence.
			expect(body.draftVersion).toBeGreaterThanOrEqual(serverDraftVersion);
			serverDraftVersion = body.draftVersion;
			serverDraftSession = body.draftSession;
			if (++attempts === 1)
				throw Object.assign(
					new Error(
						"Finish refused until source relocation is PURGED and liveKey is the relocated key",
					),
					{ status: 409 },
				);
			if (!expectedEditFenceMatches(current, body.expectedEditSpec))
				throw Object.assign(
					new Error(
						"This video was edited in another session. Reload before publishing.",
					),
					{ status: 409 },
				);
			acceptedPublishes++;
			current = body.editSpec;
			return { success: true, revisionId: "stale-A", generation: 5 };
		});
		vi.useFakeTimers();
		try {
			await act(async () => done.click());
			expect(serverDraftSession).toBe("A");
			expect(serverDraftVersion).toBe(1);
			// Separate browser B publishes its different cut at that same draft version.
			current = publishedB;
			serverDraftSession = "B";
			generation = 4;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1_000);
			});
			const publishes = harness.post.mock.calls.filter(([path]) =>
				path.endsWith("/publish"),
			);
			expect(publishes).toHaveLength(3);
			expect(serverDraftSession).toBe("A");
			expect(harness.instant).toHaveBeenCalledTimes(2);
			expect(publishes[2]?.[1]).toEqual({
				...publishes[0]?.[1],
				baseGeneration: 4,
				draftVersion: 2,
				expectedDraftSession: "A",
			});
			expect(acceptedPublishes).toBe(0);
			expect(current).toEqual(publishedB);
			expect(harness.push).not.toHaveBeenCalled();
			expect(localStorage.getItem(getTimelineDraftKey(VIDEO_ID))).toBe(
				savedDraft,
			);
			expect(storedDraft()?.state.selectedSegmentId).toBe(selectedSegmentId);
			expect(
				container.querySelector("[data-editor-shell='editor']"),
			).not.toBeNull();
			expect(container.textContent).toContain("0:08");
			expect(doneButton()?.disabled).toBe(false);
			expect(toast.error).toHaveBeenCalledWith(
				"This video was edited in another session. Reload before publishing.",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		"cut baseline",
		"V2 baseline",
		"different source",
		"rendered cut",
		"manual cut",
		"enabled autocuts",
		"latent autocuts",
	])("preserves the original fence for %s", async (change) => {
		const identity = createIdentityEditSpec(DURATION);
		const baseline =
			change === "cut baseline"
				? normalizeKeepRanges([{ start: 1, end: 9 }], DURATION)
				: change === "V2 baseline"
					? getTimelineEditSpec(createTimelineStateFromEditSpec(identity))
					: identity;
		seedDraft(baseline);
		const fresh = getTimelineEditSpec(
			createTimelineStateFromEditSpec(baseline),
		);
		if (change === "V2 baseline") fresh.autoCuts.silence.thresholdMs++;
		if (change === "different source") fresh.sourceDuration++;
		if (change === "rendered cut") fresh.keepRanges = [{ start: 1, end: 9 }];
		if (change === "manual cut")
			fresh.manualKeepRanges = [{ start: 1, end: 9 }];
		if (change === "enabled autocuts") fresh.autoCuts.fillers.enabled = true;
		if (change === "latent autocuts")
			fresh.autoCuts.silence.ranges = [{ start: 1, end: 2 }];
		localStorage.setItem(`cap:edit-draft-session:${VIDEO_ID}`, "A");
		const done = await renderEditor(baseline);
		const draft = localStorage.getItem(getTimelineDraftKey(VIDEO_ID));
		harness.instant.mockResolvedValue({
			enabled: true,
			generation: 4,
			draftVersion: 2,
			draftSession: "A",
			expectedEditSpec: fresh,
		});
		harness.post.mockImplementation(async (path: string) => {
			if (path.endsWith("/prepare")) return { generation: 3 };
			throw Object.assign(new Error("baseline conflict"), { status: 409 });
		});
		await act(async () => done.click());
		const publishes = harness.post.mock.calls.filter(([path]) =>
			path.endsWith("/publish"),
		);
		expect(publishes).toHaveLength(2);
		expect(publishes[1]?.[1].expectedEditSpec).toEqual(baseline);
		expect(publishes[1]?.[1].editSpec).toEqual(publishes[0]?.[1].editSpec);
		expect(localStorage.getItem(getTimelineDraftKey(VIDEO_ID))).toBe(draft);
		expect(harness.push).not.toHaveBeenCalled();
		expect(doneButton()?.disabled).toBe(false);
	});

	it.each(["newer version", "changed contents", "editor state"])(
		"stops stale Done retries after %s changes",
		async (change) => {
			const { baseline } = seedDraft();
			const done = await renderEditor(baseline);
			vi.useFakeTimers();
			let attempts = 0;
			harness.post.mockImplementation(async (path: string) => {
				if (path.endsWith("/prepare")) return { generation: 3 };
				if (++attempts === 1)
					throw Object.assign(
						new Error(
							"Finish refused until source relocation is PURGED and liveKey is the relocated key",
						),
						{ status: 409 },
					);
				return { success: true, revisionId: "stale", generation: 4 };
			});
			try {
				await act(async () => done.click());
				const key = getTimelineDraftKey(VIDEO_ID);
				const originalDraft = localStorage.getItem(key);
				if (!originalDraft) throw new Error("missing shared draft");
				const current = JSON.parse(originalDraft);
				let newer = JSON.stringify(
					change === "newer version"
						? { ...current, draftVersion: 20 }
						: { ...current, state: { ...current.state, trimEnd: 9 } },
				);
				if (change === "editor state") {
					// Change only the component state: leave shared storage exactly as submitted.
					newer = originalDraft;
					await act(async () =>
						root.render(
							editorElement(
								normalizeKeepRanges([{ start: 0, end: 9 }], DURATION),
							),
						),
					);
				}
				localStorage.setItem(key, newer);
				await act(async () => {
					await vi.advanceTimersByTimeAsync(1_000);
				});
				expect(attempts).toBe(1);
				expect(harness.push).not.toHaveBeenCalled();
				expect(localStorage.getItem(key)).toBe(newer);
				expect(
					container.querySelector("[data-editor-shell='editor']"),
				).not.toBeNull();
				expect(doneButton()?.disabled).toBe(false);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("unmount during privacy wait cancels retries without clearing or navigating", async () => {
		const { baseline } = seedDraft();
		const done = await renderEditor(baseline);
		vi.useFakeTimers();
		let attempts = 0;
		let signal: AbortSignal | undefined;
		harness.post.mockImplementation(
			async (path: string, _body: unknown, requestSignal: AbortSignal) => {
				if (path.endsWith("/prepare")) return { generation: 3 };
				signal = requestSignal;
				if (++attempts === 1)
					throw Object.assign(
						new Error(
							"Finish refused until source relocation is PURGED and liveKey is the relocated key",
						),
						{ status: 409 },
					);
				return { success: true, revisionId: "detached", generation: 4 };
			},
		);
		try {
			await act(async () => done.click());
			const draft = localStorage.getItem(getTimelineDraftKey(VIDEO_ID));
			await act(async () => root.unmount());
			expect(signal?.aborted).toBe(true);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(61_000);
			});
			expect(attempts).toBe(1);
			expect(harness.push).not.toHaveBeenCalled();
			expect(localStorage.getItem(getTimelineDraftKey(VIDEO_ID))).toBe(draft);
			expect(toast.error).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["success", "failure"])(
		"ignores late in-flight %s after unmount",
		async (result) => {
			const { baseline } = seedDraft();
			const done = await renderEditor(baseline);
			let finish: () => void = () => {};
			harness.post.mockImplementation((path: string) => {
				if (path.endsWith("/prepare"))
					return Promise.resolve({ generation: 3 });
				return new Promise((resolve, reject) => {
					finish = () =>
						result === "success"
							? resolve({ success: true, revisionId: "late", generation: 4 })
							: reject(new Error("late failure"));
				});
			});
			await act(async () => done.click());
			const draft = localStorage.getItem(getTimelineDraftKey(VIDEO_ID));
			await act(async () => root.unmount());
			await act(async () => finish());
			expect(harness.push).not.toHaveBeenCalled();
			expect(localStorage.getItem(getTimelineDraftKey(VIDEO_ID))).toBe(draft);
			expect(toast.error).not.toHaveBeenCalled();
		},
	);

	it("honours an in-flight publish success after 60 seconds and navigates", async () => {
		const { baseline } = seedDraft();
		const done = await renderEditor(baseline);
		vi.useFakeTimers();
		harness.post.mockImplementation(
			(path: string, _body: unknown, signal: AbortSignal) => {
				if (path.endsWith("/prepare"))
					return Promise.resolve({ generation: 3 });
				return new Promise((resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
					setTimeout(
						() => resolve({ success: true, revisionId: "slow", generation: 4 }),
						61_000,
					);
				});
			},
		);
		try {
			await act(async () => done.click());
			await act(async () => {
				await vi.advanceTimersByTimeAsync(60_000);
			});
			expect(
				container.querySelector("[data-editor-shell='publishing']"),
			).not.toBeNull();
			expect(storedDraft()).not.toBeNull();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1_000);
			});
			expect(harness.push).toHaveBeenCalledExactlyOnceWith(`/s/${VIDEO_ID}`);
			expect(storedDraft()).toBeNull();
			expect(toast.error).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
	it("shows privacy progress through delayed Done retries, then navigates", async () => {
		const { baseline } = seedDraft();
		const done = await renderEditor(baseline);
		vi.useFakeTimers();
		let attempts = 0;
		harness.post.mockImplementation(async (path: string) => {
			if (path.endsWith("/prepare")) return { generation: 3 };
			if (++attempts <= 3)
				throw Object.assign(
					new Error(
						"Finish refused until source relocation is PURGED and liveKey is the relocated key",
					),
					{ status: 409 },
				);
			return { success: true, revisionId: "published", generation: 4 };
		});
		try {
			await act(async () => done.click());
			expect(container.querySelector("output")?.textContent).toBe(
				"Waiting for source privacy checks… (up to 60 seconds)",
			);
			expect(storedDraft()).not.toBeNull();
			expect(harness.push).not.toHaveBeenCalled();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3_000);
			});
			expect(attempts).toBe(4);
			expect(harness.push).toHaveBeenCalledWith(`/s/${VIDEO_ID}`);
			expect(storedDraft()).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
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
			expect.any(AbortSignal),
		);
		expect(harness.push).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "409",
			error: Object.assign(new Error("generation mismatch"), { status: 409 }),
			retryError: Object.assign(new Error("Draft version changed again"), {
				status: 409,
			}),
			toast: "Draft version changed again",
		},
		{
			name: "source not ready",
			error: Object.assign(
				new Error("Immutable source identity is not ready. Reopen the editor."),
				{ status: 409 },
			),
			toast: "Still preparing for editing — try again in a moment.",
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
		async ({ error, retryError, toast: toastMessage }) => {
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

			if (retryError) harness.post.mockRejectedValueOnce(retryError);
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
			const retried = "status" in error && error.status === 409;
			expect(harness.instant).toHaveBeenCalledTimes(retried ? 2 : 1);
			expect(
				harness.post.mock.calls.filter(([path]) => path.endsWith("/publish")),
			).toHaveLength(retried ? 2 : 1);
		},
	);

	it.each(["same", "empty", "warm-expired"])(
		"retries Done once with a %s session and fresh counters",
		async (session) => {
			const { baseline } = seedDraft();
			const draftSession = "this-editor-session";
			localStorage.setItem(`cap:edit-draft-session:${VIDEO_ID}`, draftSession);
			const done = await renderEditor(baseline);
			harness.instant.mockResolvedValue({
				enabled: true,
				generation: 8,
				draftVersion: 6,
				draftSession: session === "empty" ? "" : draftSession,
			});
			harness.post.mockImplementation((path: string) => {
				if (path.endsWith("/prepare")) {
					return Promise.resolve({ revisionId: "prepared", generation: 4 });
				}
				const publishes = harness.post.mock.calls.filter(([route]) =>
					route.endsWith("/publish"),
				);
				return publishes.length === 1
					? Promise.reject(
							Object.assign(
								new Error(
									session === "warm-expired"
										? "Editor-open warm expired. Reopen the editor."
										: "stale draft",
								),
								{ status: 409 },
							),
						)
					: Promise.resolve({ success: true, playback: null });
			});

			await act(async () => done.click());

			const publishes = harness.post.mock.calls.filter(([path]) =>
				path.endsWith("/publish"),
			);
			expect(publishes).toHaveLength(2);
			expect(publishes[0]?.[1]).toMatchObject({ draftSession });
			expect(publishes[0]?.[1]).not.toHaveProperty("expectedDraftSession");
			expect(publishes[1]?.[1]).toEqual({
				...publishes[0]?.[1],
				baseGeneration: 8,
				draftVersion: 7,
				expectedDraftSession: session === "empty" ? "" : draftSession,
			});
			expect(harness.instant).toHaveBeenLastCalledWith({
				videoId: VIDEO_ID,
				ownerId: "owner-1",
			});
			expect(harness.instant).toHaveBeenCalledTimes(2);
			if (session === "warm-expired") {
				expect(harness.rewarm).toHaveBeenCalledExactlyOnceWith(VIDEO_ID);
				expect(harness.rewarm.mock.invocationCallOrder[0]).toBeLessThan(
					harness.instant.mock.invocationCallOrder[1] ?? 0,
				);
			} else {
				expect(harness.rewarm).not.toHaveBeenCalled();
			}
			expect(harness.push).toHaveBeenCalledWith(`/s/${VIDEO_ID}`);
			expect(storedDraft()).toBeNull();
			expect(toast.error).not.toHaveBeenCalled();
		},
	);

	it.each(["prepare failure", "stale action"])(
		"preserves the draft after re-warm %s and restores it on reload",
		async (failure) => {
			const { baseline, selectedSegmentId } = seedDraft();
			const done = await renderEditor(baseline);
			const draftBefore = storedDraft();
			const message = "Source identity changed after it was recorded";
			if (failure === "stale action") {
				harness.rewarm.mockRejectedValueOnce(
					new Error('Failed to find Server Action "old-action".'),
				);
			} else {
				harness.rewarm.mockResolvedValueOnce({
					success: false,
					error: message,
				});
			}
			await act(async () => done.click());
			await act(async () => {
				rejectPublish(
					Object.assign(
						new Error("Editor-open warm expired. Reopen the editor."),
						{ status: 409 },
					),
				);
			});
			expect(harness.rewarm).toHaveBeenCalledExactlyOnceWith(VIDEO_ID);
			expect(harness.instant).toHaveBeenCalledTimes(1);
			expect(
				harness.post.mock.calls.filter(([path]) => path.endsWith("/publish")),
			).toHaveLength(1);
			expect(toast.error).toHaveBeenCalledWith(
				failure === "stale action"
					? "Cap was updated. Reload the page to continue — edits saved in this browser will be restored."
					: message,
			);
			expect(harness.push).not.toHaveBeenCalled();
			expect(doneButton()?.disabled).toBe(false);
			expect(container.textContent).toContain("0:08");
			expect(storedDraft()).toEqual(draftBefore);
			await act(async () => root.unmount());
			root = createRoot(container);
			await renderEditor(baseline);
			expect(container.textContent).toContain("0:08");
			expect(storedDraft()?.state.selectedSegmentId).toBe(selectedSegmentId);
		},
	);

	it.each(["stale draft", ""])(
		"does not retry across sessions with server message %j",
		async (message) => {
			const { baseline, selectedSegmentId } = seedDraft();
			const done = await renderEditor(baseline);
			harness.instant.mockResolvedValue({
				enabled: true,
				generation: 8,
				draftVersion: 6,
				draftSession: "another-session",
			});
			await act(async () => done.click());
			await act(async () => {
				rejectPublish(Object.assign(new Error(message), { status: 409 }));
			});
			expect(
				harness.post.mock.calls.filter(([path]) => path.endsWith("/publish")),
			).toHaveLength(1);
			expect(harness.instant).toHaveBeenCalledTimes(2);
			expect(harness.push).not.toHaveBeenCalled();
			expect(
				container.querySelector("[data-editor-shell='editor']"),
			).not.toBeNull();
			expect(container.textContent).toContain("0:08");
			expect(storedDraft()?.state.selectedSegmentId).toBe(selectedSegmentId);
			expect(doneButton()?.disabled).toBe(false);
			expect(toast.error).toHaveBeenCalledWith(
				message ||
					"This video was edited in another session. Reload before publishing.",
			);
		},
	);
});

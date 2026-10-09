// @vitest-environment jsdom

import { act, createElement, createRef, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadProgress } from "@/app/s/[videoId]/_components/upload-progress";
import {
	preferInstantFinishFirstPaint,
	stashInstantFinishPlayback,
} from "@/lib/instant-finish-playback-handoff";
import type { ClientRevisionPlayback } from "@/lib/revision-playback";

const mocks = vi.hoisted(() => ({
	progress: null as UploadProgress | null,
	status: 204,
	handlers: new Map<string, (...args: unknown[]) => void>(),
	pause: vi.fn(),
	stopLoad: vi.fn(),
	loadSource: vi.fn(),
	supported: true,
	router: { refresh: vi.fn() },
}));

vi.mock("next/navigation", () => ({
	useRouter: () => mocks.router,
}));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/actions/video/retry-processing", () => ({
	retryVideoProcessing: vi.fn(),
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/app/s/[videoId]/_components/caption-tracks", () => ({
	bindCaptionTrackCueText: () => () => {},
}));
vi.mock("@/app/s/[videoId]/_components/VideoPreviewGif", () => ({
	VideoPreviewGif: () => null,
}));
vi.mock("@cap/ui", () => ({ LogoSpinner: () => null }));
vi.mock("@cap/utils", () => ({
	getProgressCircleConfig: () => ({ circumference: 50 }),
	calculateStrokeDashoffset: () => 0,
}));
vi.mock("next/dynamic", async () => {
	const { useEffect } = await import("react");
	return {
		default:
			() =>
			({
				onChange,
			}: {
				onChange: (progress: UploadProgress | null) => void;
			}) => {
				const progress = mocks.progress;
				useEffect(() => onChange(progress), [onChange, progress]);
				return null;
			},
	};
});
vi.mock("motion/react", async () => {
	const { createElement } = await import("react");
	return {
		AnimatePresence: ({ children }: { children: ReactNode }) => children,
		motion: {
			div: ({
				children,
				className,
			}: {
				children?: ReactNode;
				className?: string;
			}) => createElement("div", { className }, children),
		},
	};
});
vi.mock("hls.js", () => ({
	default: class {
		static isSupported = () => mocks.supported;
		static DefaultConfig = {
			loader: class {
				load() {}
			},
		};
		static Events = {
			ERROR: "error",
			MANIFEST_LOADED: "manifestLoaded",
			MANIFEST_PARSED: "manifestParsed",
			FRAG_LOADED: "fragLoaded",
		};
		static ErrorTypes = { NETWORK_ERROR: "network", MEDIA_ERROR: "media" };
		static ErrorDetails = {};
		loadSource = mocks.loadSource;
		attachMedia() {}
		startLoad() {}
		stopLoad = mocks.stopLoad;
		destroy() {}
		on(event: string, callback: (...args: unknown[]) => void) {
			mocks.handlers.set(event, callback);
		}
	},
}));
vi.mock("@/app/s/[videoId]/_components/video/media-player", async () => {
	const { createElement, forwardRef } = await import("react");
	const wrapper = ({ children }: { children?: ReactNode }) =>
		createElement("div", null, children);
	const empty = () => null;
	return {
		MediaPlayer: wrapper,
		MediaPlayerControls: wrapper,
		MediaPlayerVideo: forwardRef(
			({ children }: { children?: ReactNode }, ref: Ref<HTMLVideoElement>) =>
				createElement("video", { ref }, children),
		),
		MediaPlayerPlaybackSpeedDial: () =>
			createElement("button", null, "Ready to play"),
		MediaPlayerCaptions: empty,
		MediaPlayerControlsOverlay: empty,
		MediaPlayerError: empty,
		MediaPlayerFullscreen: empty,
		MediaPlayerLoading: empty,
		MediaPlayerPiP: empty,
		MediaPlayerPlay: empty,
		MediaPlayerSeek: empty,
		MediaPlayerSeekBackward: empty,
		MediaPlayerSeekForward: empty,
		MediaPlayerSettings: empty,
		MediaPlayerTime: empty,
		MediaPlayerVolume: empty,
		MediaPlayerVolumeIndicator: empty,
	};
});

import { HLSVideoPlayer } from "@/app/s/[videoId]/_components/HLSVideoPlayer";

describe("Instant player readiness and failure UX", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let videoRef: ReturnType<typeof createRef<HTMLVideoElement>>;
	beforeEach(() => {
		mocks.supported = true;
		sessionStorage.clear();
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
		vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue(
			"probably",
		);
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: mocks.status })),
		);
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
			mocks.pause,
		);
		mocks.progress = {
			status: "processing",
			progress: 15,
			message: "Finishing",
			lastUpdated: new Date(),
		};
		mocks.status = 204;
		mocks.handlers.clear();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		videoRef = createRef<HTMLVideoElement>();
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});
	const render = () =>
		act(async () => {
			root.render(
				createElement(HLSVideoPlayer, {
					videoId: "recording" as Parameters<
						typeof HLSVideoPlayer
					>[0]["videoId"],
					videoSrc:
						"/api/playlist?videoId=recording&videoType=segments-master&requireComplete=1",
					videoRef,
					chaptersSrc: "",
					captionsSrc: "",
					isLiveSegments: true,
					hasActiveUpload: true,
					allowSegmentProbeDuringUpload: true,
				}),
			);
		});
	const decodeFrame = () =>
		act(async () => {
			videoRef.current?.dispatchEvent(new Event("loadeddata"));
		});

	const revision = (
		generation: number,
	): Extract<ClientRevisionPlayback, { mode: "hls" }> => ({
		mode: "hls",
		videoId: "recording",
		revisionId: `rev-${generation}`,
		generation,
		playlistUrl: `/media/recording/r/rev-${generation}/playlist.m3u8?t=test-grant`,
		duration: 45,
		captionsUrl: null,
		chapters: [],
		commentTimestamps: null,
		thumbnailUrl: null,
		downloadReady: false,
	});
	const renderRevision = async (
		playback: Extract<ClientRevisionPlayback, { mode: "hls" }>,
	) => {
		const render = () => {
			root.render(
				createElement(HLSVideoPlayer, {
					videoId: "recording" as Parameters<
						typeof HLSVideoPlayer
					>[0]["videoId"],
					videoSrc: playback.playlistUrl,
					revisionPlayback: playback,
					videoRef,
					chaptersSrc: "",
					captionsSrc: "",
				}),
			);
		};
		await act(render);
		// Settle the initial null -> mounted videoRef effect dependency before errors.
		await act(render);
	};
	const revisionError = () =>
		act(async () => {
			if (mocks.supported) {
				const error = mocks.handlers.get("error");
				// A burst must coalesce into one authorization/readback request.
				error?.("error", {
					response: { code: 410 },
					fatal: false,
					details: "fragLoadError",
				});
				error?.("error", {
					response: { code: 410 },
					fatal: false,
					details: "fragLoadError",
				});
			} else {
				videoRef.current?.dispatchEvent(new Event("error"));
				videoRef.current?.dispatchEvent(new Event("error"));
			}
		});

	it.each([true, false])(
		"recovers gen4 handoff to CURRENT gen1 after readback revert (hls.js=%s)",
		async (supported) => {
			mocks.supported = supported;
			const published = revision(4);
			stashInstantFinishPlayback(
				{
					...published,
					grantExpiresAt: 60,
					revisionMetadata: {
						playlistPath: "playlist.m3u8",
						duration: 45,
						chapters: [],
						captionsAvailable: false,
						commentTimestamps: {},
						thumbnailAvailable: false,
						downloadReady: false,
						summaryStatus: "persisted",
						summaryDerived: false,
						summaryText: null,
						captions: "unavailable",
						chaptersStatus: "revision",
						thumbnail: "seg0-first-frame",
						download: "preparing",
						commentClock: "output-time",
						removedRangeComments: "hidden",
					},
				},
				sessionStorage,
			);
			const arrival = preferInstantFinishFirstPaint({
				videoId: "recording",
				ssr: published,
				storage: sessionStorage,
				nowMs: 0,
			});
			expect(arrival.fromHandoff).toBe(true);
			await renderRevision(arrival.playback as typeof published);
			const fetchGrant = vi.fn(async () =>
				Response.json({
					revisionId: "rev-1",
					changed: true,
					grant: "current-grant",
				}),
			);
			vi.stubGlobal("fetch", fetchGrant);
			await revisionError();
			expect(fetchGrant).toHaveBeenCalledTimes(1);
			expect(fetchGrant).toHaveBeenCalledWith(
				"/api/media/grant",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ videoId: "recording", revisionId: "rev-4" }),
				}),
			);
			expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
			expect(mocks.pause).toHaveBeenCalled();
			// Model the server props delivered by router.refresh, not a new grant on gen4.
			const current = preferInstantFinishFirstPaint({
				videoId: "recording",
				ssr: revision(1),
				storage: sessionStorage,
				nowMs: 0,
			});
			expect(current.fromHandoff).toBe(false);
			mocks.loadSource.mockClear();
			await renderRevision(current.playback as typeof published);
			if (supported)
				expect(mocks.loadSource.mock.calls).toEqual([
					[revision(1).playlistUrl],
				]);
			else
				expect(videoRef.current?.getAttribute("src")).toBe(
					revision(1).playlistUrl,
				);
			await decodeFrame();
			expect(container.textContent).toContain("Ready to play");
			expect(container.textContent).not.toContain("This video could not load");
		},
	);

	it.each(["unmount", "revision change"])(
		"ignores a deferred grant after player %s",
		async (change) => {
			await renderRevision(revision(4));
			let resolveGrant!: (response: Response) => void;
			const fetchGrant = vi.fn(
				() =>
					new Promise<Response>((resolve) => {
						resolveGrant = resolve;
					}),
			);
			vi.stubGlobal("fetch", fetchGrant);
			await revisionError();
			expect(fetchGrant).toHaveBeenCalledTimes(1);
			if (change === "unmount") await act(() => root.render(null));
			else
				await renderRevision({
					...revision(1),
					playlistUrl: revision(4).playlistUrl,
				});
			mocks.pause.mockClear();
			await act(async () =>
				resolveGrant(
					Response.json({
						revisionId: "rev-1",
						changed: true,
						grant: "current-grant",
					}),
				),
			);
			expect(mocks.router.refresh).not.toHaveBeenCalled();
			expect(mocks.pause).not.toHaveBeenCalled();
			expect(container.textContent).not.toContain("This video could not load");
			expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		},
	);

	it("refreshes server playback props on an authorized changed revision even after 401", async () => {
		await renderRevision(revision(4));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					revisionId: "rev-1",
					changed: true,
					grant: "current-grant",
				}),
			),
		);
		await act(async () =>
			mocks.handlers.get("error")?.("error", {
				response: { code: 401 },
				fatal: false,
			}),
		);
		expect(mocks.router.refresh).toHaveBeenCalledTimes(1);
	});

	it.each([401, 403])(
		"does not recover a revoked viewer when grant reauthorization returns %s",
		async (status) => {
			await renderRevision(revision(4));
			const fetchGrant = vi.fn(async () => new Response(null, { status }));
			vi.stubGlobal("fetch", fetchGrant);
			mocks.loadSource.mockClear();
			await revisionError();
			expect(fetchGrant).toHaveBeenCalledTimes(1);
			expect(mocks.router.refresh).not.toHaveBeenCalled();
			expect(mocks.loadSource).not.toHaveBeenCalled();
			expect(mocks.pause).toHaveBeenCalled();
			expect(container.textContent).toContain("This video could not load");
		},
	);

	it("stops on origin 403 without refreshing or requesting a grant", async () => {
		await renderRevision(revision(4));
		const fetchGrant = vi.fn();
		vi.stubGlobal("fetch", fetchGrant);
		await act(async () =>
			mocks.handlers.get("error")?.("error", {
				response: { code: 403 },
				fatal: false,
			}),
		);
		expect(fetchGrant).not.toHaveBeenCalled();
		expect(mocks.router.refresh).not.toHaveBeenCalled();
		expect(mocks.pause).toHaveBeenCalled();
	});

	it("waits for a decoded frame, not just a parsed playlist", async () => {
		await render();
		await act(async () => mocks.handlers.get("manifestParsed")?.());
		expect(container.textContent).not.toContain("Ready to play");
		await decodeFrame();
		expect(container.textContent).toContain("Ready to play");
		expect(container.textContent).not.toContain("Processing");
	});

	it("shows an incomplete recording immediately without a playable silent fallback", async () => {
		mocks.status = 409;
		await render();
		expect(container.textContent).toContain("missing some video or audio");
		expect(container.textContent).not.toContain("Ready to play");
		expect(container.textContent).not.toContain("Retry Processing");
	});

	it("does not hide a source validation failure arriving after the first frame", async () => {
		await render();
		await decodeFrame();
		mocks.progress = {
			status: "error",
			errorMessage: "source-invalid: Audio is truncated",
			hasRawFallback: false,
			lastUpdated: new Date(),
		};
		await render();
		expect(container.textContent).toContain("missing some video or audio");
		expect(container.textContent).not.toContain("Ready to play");
		expect(mocks.pause).toHaveBeenCalled();
	});

	it("keeps a playable source available when only final processing fails", async () => {
		await render();
		await decodeFrame();
		mocks.progress = {
			status: "error",
			errorMessage: "workflow-dispatch-failed: worker unavailable",
			hasRawFallback: false,
			lastUpdated: new Date(),
		};
		await render();
		expect(container.textContent).toContain("Ready to play");
		expect(container.textContent).not.toContain("worker unavailable");
		expect(mocks.pause).not.toHaveBeenCalled();
	});
});

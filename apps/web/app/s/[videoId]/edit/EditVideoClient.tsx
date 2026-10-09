"use client";

import type { VideoAutoCuts, VideoEditSpec } from "@cap/database/types";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@cap/ui";
import type { Video } from "@cap/web-domain";
import {
	ChevronLeft,
	ChevronRight,
	Pause,
	Play,
	Redo2,
	RotateCcw,
	Scissors,
	Trash2,
	Undo2,
	X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
	Fragment,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { getVideoDownloadInfo } from "@/actions/videos/download";
import { requestEditTranscript } from "@/actions/videos/get-edit-transcript";
import {
	getEditorInstantFinishState,
	rewarmEditorSource,
} from "@/actions/videos/publish-revision";
import {
	restoreVideoToOriginal,
	saveVideoEdits,
} from "@/actions/videos/save-edits";
import { restoredEditorSpec } from "@/lib/editor-baseline";
import { isEditorShortcutTarget } from "@/lib/editor-keyboard";
import {
	prefetchInstantFinishPlaylist,
	stashInstantFinishPlayback,
} from "@/lib/instant-finish-playback-handoff";
import {
	doneRoute,
	publishDoneWithRetry,
	readOrCreateDraftSession,
	restoreRoute,
} from "@/lib/revision-done";
import { createPrepareOnce, prepareSpecKey } from "@/lib/revision-prepare-once";
import { postRevisionRoute } from "@/lib/revision-publish-client";
import {
	acceptSettledPrepare,
	beginDoneFence,
	nextSettlePrepare,
	SETTLE_PREPARE_DEBOUNCE_MS,
	shouldJoinInflightPrepare,
} from "@/lib/revision-settle-fence";
import {
	clearTimelineDraft,
	getTimelineDraftKey,
	getTimelineDraftStorage,
	readTimelineDraft,
	writeTimelineDraft,
} from "@/lib/video-edit-drafts";
import {
	areEditSpecDocumentsEquivalent,
	areEditSpecsEquivalent,
	areTimelineStatesEquivalent,
	createIdentityEditSpec,
	createTimelineHistory,
	createTimelineStateFromEditSpec,
	deleteSelectedTimelineSegment,
	deleteTimelineRanges,
	findNextPlayableTime,
	findNextPlayableTimeInRanges,
	findPlayableRangeIndex,
	findPreviousPlayableTime,
	getEditSpecOutputDuration,
	getTimelineDisplaySplitPoints,
	getTimelineEditSpec,
	getTimelineKeepRanges,
	getTimelineSegments,
	mapSourceTimeToOutputTime,
	normalizeVideoEditSpec,
	pushTimelineHistory,
	redoTimelineHistory,
	removeTimelineDisplaySplitPoint,
	restoreTimelineRanges,
	selectTimelineSegment,
	setTimelineAutoCutLayer,
	splitTimelineAt,
	type TimelineHistory,
	trimTimelineClipEdge,
	undoTimelineHistory,
	type VideoTimelineState,
} from "@/lib/video-edits";
import { decodePeaksObject, type PeakPair } from "@/lib/waveform-peaks";
import { navigateWithTransition } from "@/utils/view-transition";
import { useEditReadiness } from "../../../../hooks/use-edit-readiness";
import { CapVideoPlayer } from "../_components/CapVideoPlayer";
import { VideoDownloadMenu } from "../_components/VideoDownloadMenu";
import { captureVideoFrameDataUrl } from "../_components/video-frame-thumbnail";
import {
	EditorChapterMarkers,
	useEditorChapterPreview,
} from "./EditorChapterPreview";
import {
	capsuleOutlineGroups,
	EditorChapterLane,
	EditorHoverGhost,
	EditorPlayhead,
	EditorTimelineRuler,
	EditorWaveformCanvas,
	EditorWaveformToolbar,
	effectiveMaxPxPerSec,
	effectivePxPerSec,
	fitFloorPxPerSec,
	formatZoomMeasure,
	nextWaveformRetryMs,
	preferenceFromSliderStop,
	relativeZoomForPreference,
	sliderStopForPreference,
	stepEditingDensity,
	type ViewportPreference,
	waveformFetchUrl,
	ZOOM_DENSITY_FACTOR,
} from "./EditorWaveform";
import { EditReadinessStatus } from "./EditReadinessGate";
import { TranscriptSidebar } from "./TranscriptSidebar";
import { useRenewingPlaybackSource } from "./use-renewing-playback-source";

type EditableVideo = {
	id: Video.VideoId;
	name: string;
	ownerId: string;
	duration: number;
	width: number | null;
	height: number | null;
	transcriptionStatus: string | null;
};

type DragHandle = "start" | "end";

const MAX_TIMELINE_THUMBNAILS = 48;
const MAX_VISIBLE_THUMBNAIL_GENERATION = 16;
const PREVIEW_CUT_MUTE_LEAD_SECONDS = 0.03;
const TIMELINE_THUMBNAIL_WIDTH = 160;
const TIMELINE_THUMBNAIL_HEIGHT = 90;
const THUMBNAIL_FRAME_BATCH_SIZE = 4;

type TimelineThumbnailFrame = {
	src: string;
	time: number;
};

type TimelineThumbnailRequest = {
	key: string;
	time: number;
};

function formatTime(seconds: number) {
	const safeSeconds = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(safeSeconds / 60);
	const remainingSeconds = safeSeconds % 60;
	return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatTimeDetailed(seconds: number) {
	const safe = Math.max(0, seconds);
	const minutes = Math.floor(safe / 60);
	const remainingSeconds = safe - minutes * 60;
	const padded = remainingSeconds.toFixed(2).padStart(5, "0");
	return `${String(minutes).padStart(2, "0")}:${padded}`;
}

function getTimePercent(time: number, duration: number) {
	if (duration <= 0) return 0;
	return Math.min(100, Math.max(0, (time / duration) * 100));
}

function waitForNextFrame() {
	return new Promise<void>((resolve) => {
		requestAnimationFrame(() => resolve());
	});
}

function scheduleIdle(callback: () => void) {
	const idleWindow = window as Window & {
		requestIdleCallback?: (
			callback: () => void,
			options?: { timeout?: number },
		) => number;
		cancelIdleCallback?: (id: number) => void;
	};

	if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
		const id = idleWindow.requestIdleCallback(callback, { timeout: 500 });
		return () => idleWindow.cancelIdleCallback?.(id);
	}

	const id = window.setTimeout(callback, 120);
	return () => window.clearTimeout(id);
}

function getTimelineThumbnailTime(
	index: number,
	count: number,
	duration: number,
) {
	if (duration <= 0 || count <= 0) return 0;
	const slotProgress = (index + 0.5) / count;
	return Math.min(Math.max(slotProgress * duration, 0), duration);
}

function getTimelineThumbnailKey(time: number) {
	return `${Math.round(time * 10) / 10}`;
}

function getNearestTimelineFrame(
	frames: TimelineThumbnailFrame[],
	time: number,
) {
	let nearest: TimelineThumbnailFrame | null = null;
	let nearestDistance = Number.POSITIVE_INFINITY;

	for (const frame of frames) {
		const distance = Math.abs(frame.time - time);
		if (distance < nearestDistance) {
			nearest = frame;
			nearestDistance = distance;
		}
	}

	return nearest;
}

function waitForVideoMetadata(video: HTMLVideoElement) {
	if (video.readyState >= 1) return Promise.resolve(true);

	return new Promise<boolean>((resolve) => {
		let timeoutId = 0;
		const settle = (value: boolean) => {
			window.clearTimeout(timeoutId);
			video.removeEventListener("loadedmetadata", handleLoaded);
			video.removeEventListener("error", handleError);
			resolve(value);
		};
		const handleLoaded = () => settle(true);
		const handleError = () => settle(false);

		timeoutId = window.setTimeout(() => settle(false), 5000);
		video.addEventListener("loadedmetadata", handleLoaded);
		video.addEventListener("error", handleError);
	});
}

function seekVideoForThumbnail(video: HTMLVideoElement, time: number) {
	return new Promise<boolean>((resolve) => {
		let timeoutId = 0;
		let frameId = 0;
		const settle = (value: boolean) => {
			window.clearTimeout(timeoutId);
			cancelAnimationFrame(frameId);
			video.removeEventListener("seeked", handleSeeked);
			video.removeEventListener("loadeddata", handleLoadedData);
			video.removeEventListener("error", handleError);
			resolve(value);
		};
		const handleSeeked = () => settle(true);
		const handleLoadedData = () => {
			if (Math.abs(video.currentTime - time) <= 0.08) settle(true);
		};
		const handleError = () => settle(false);

		timeoutId = window.setTimeout(() => settle(false), 3500);
		video.addEventListener("seeked", handleSeeked);
		video.addEventListener("loadeddata", handleLoadedData);
		video.addEventListener("error", handleError);

		try {
			video.currentTime = time;
			if (video.readyState >= 2 && Math.abs(video.currentTime - time) <= 0.08) {
				frameId = requestAnimationFrame(() => settle(true));
			}
		} catch {
			settle(false);
		}
	});
}

function releaseThumbnailVideo(video: HTMLVideoElement | null) {
	if (!video) return;
	video.removeAttribute("src");
	video.load();
}

function getClampedVideoTime(
	time: number,
	video: HTMLVideoElement | null,
	fallbackDuration: number,
) {
	const upper =
		video && Number.isFinite(video.duration)
			? Math.min(video.duration, fallbackDuration)
			: fallbackDuration;
	return Math.min(Math.max(time, 0), upper);
}

function getTimelineSourceTimeFromClientX(
	clientX: number,
	rect: DOMRect,
	state: VideoTimelineState,
) {
	const duration = state.duration;
	if (duration <= 0 || rect.width <= 0) return 0;
	const x = Math.min(Math.max(clientX - rect.left, 0), rect.width);
	return (x / rect.width) * duration;
}

function HeaderIconButton({
	label,
	disabled,
	onClick,
	children,
}: {
	label: string;
	disabled?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
			className="inline-flex size-9 items-center justify-center rounded-full text-gray-12 transition hover:bg-gray-3 active:bg-gray-4 disabled:pointer-events-none disabled:opacity-30"
		>
			{children}
		</button>
	);
}

function ToolButton({
	active,
	disabled,
	onClick,
	icon,
	label,
	tone = "default",
}: {
	active?: boolean;
	disabled?: boolean;
	onClick: () => void;
	icon: React.ReactNode;
	label: string;
	tone?: "default" | "danger";
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className={[
				"inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition",
				active
					? "bg-pink-500 text-white shadow-[0_2px_8px_-2px_rgba(236,72,153,0.6)]"
					: tone === "danger"
						? "text-red-500 hover:bg-red-50 active:bg-red-100"
						: "text-gray-12 hover:bg-gray-3 active:bg-gray-4",
				"disabled:pointer-events-none disabled:opacity-30",
			].join(" ")}
		>
			{icon}
			<span>{label}</span>
		</button>
	);
}

function useThumbnailCount(
	ref: React.RefObject<HTMLDivElement | null>,
	active: boolean,
) {
	const [count, setCount] = useState(8);

	useEffect(() => {
		if (!active) return;
		const node = ref.current;
		if (!node) return;

		const resizeObserver = new ResizeObserver(([entry]) => {
			const width = entry?.contentRect.width ?? 0;
			const nextCount = Math.min(
				MAX_TIMELINE_THUMBNAILS,
				Math.max(6, Math.floor(width / 96)),
			);
			setCount((current) => (current === nextCount ? current : nextCount));
		});

		resizeObserver.observe(node);
		return () => resizeObserver.disconnect();
	}, [active, ref]);

	return count;
}

function isThumbnailResponse(value: unknown): value is { screen: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"screen" in value &&
		typeof value.screen === "string"
	);
}

function useTimelineCoverThumbnail(videoId: Video.VideoId) {
	const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		setThumbnailUrl(null);
		const timeoutId = window.setTimeout(async () => {
			try {
				const response = await fetch(
					`/api/thumbnail?videoId=${encodeURIComponent(videoId)}`,
					{ signal: controller.signal },
				);
				if (!response.ok) return;
				const body: unknown = await response.json();
				if (!controller.signal.aborted && isThumbnailResponse(body)) {
					setThumbnailUrl(body.screen);
				}
			} catch (error) {
				if (error instanceof DOMException && error.name === "AbortError") {
					return;
				}
			}
		}, 0);

		return () => {
			window.clearTimeout(timeoutId);
			controller.abort();
		};
	}, [videoId]);

	return thumbnailUrl;
}

function useVisibleTimelineThumbnailRange({
	scrollContainerRef,
	timelineRef,
	thumbnailCount,
	active,
}: {
	scrollContainerRef: React.RefObject<HTMLDivElement | null>;
	timelineRef: React.RefObject<HTMLDivElement | null>;
	thumbnailCount: number;
	active: boolean;
}) {
	const [range, setRange] = useState(() => ({
		start: 0,
		end: Math.max(0, Math.min(thumbnailCount - 1, 7)),
	}));

	useEffect(() => {
		if (!active) return;
		const container = scrollContainerRef.current;
		const timeline = timelineRef.current;
		if (!container || !timeline || thumbnailCount <= 0) {
			setRange({ start: 0, end: -1 });
			return;
		}

		let frameId = 0;
		const updateRange = () => {
			cancelAnimationFrame(frameId);
			frameId = requestAnimationFrame(() => {
				const timelineWidth =
					timeline.scrollWidth || timeline.getBoundingClientRect().width;
				const slotWidth = timelineWidth / thumbnailCount;
				if (slotWidth <= 0) {
					setRange({ start: 0, end: -1 });
					return;
				}

				const rawStart = Math.floor(container.scrollLeft / slotWidth) - 1;
				const rawEnd =
					Math.ceil(
						(container.scrollLeft + container.clientWidth) / slotWidth,
					) + 1;
				const start = Math.min(Math.max(rawStart, 0), thumbnailCount - 1);
				const end = Math.min(
					Math.max(rawEnd, start),
					start + MAX_VISIBLE_THUMBNAIL_GENERATION - 1,
					thumbnailCount - 1,
				);

				setRange((current) =>
					current.start === start && current.end === end
						? current
						: { start, end },
				);
			});
		};

		updateRange();
		container.addEventListener("scroll", updateRange, { passive: true });
		const resizeObserver = new ResizeObserver(updateRange);
		resizeObserver.observe(container);
		resizeObserver.observe(timeline);

		return () => {
			cancelAnimationFrame(frameId);
			container.removeEventListener("scroll", updateRange);
			resizeObserver.disconnect();
		};
	}, [active, scrollContainerRef, thumbnailCount, timelineRef]);

	return range;
}

function useLazyTimelineThumbnails({
	videoSrc,
	sourceDuration,
	thumbnailTimes,
	visibleRange,
	enabled,
}: {
	videoSrc: string;
	sourceDuration: number;
	thumbnailTimes: TimelineThumbnailRequest[];
	visibleRange: { start: number; end: number };
	enabled: boolean;
}) {
	const [frames, setFrames] = useState<Record<string, TimelineThumbnailFrame>>(
		{},
	);
	const processedRef = useRef<Set<string>>(new Set());
	const resetKey = `${videoSrc}:${sourceDuration}`;
	const resetKeyRef = useRef(resetKey);

	useEffect(() => {
		if (resetKeyRef.current === resetKey) return;
		resetKeyRef.current = resetKey;
		processedRef.current = new Set();
		setFrames({});
	}, [resetKey]);

	useEffect(() => {
		if (
			!enabled ||
			!videoSrc ||
			sourceDuration <= 0 ||
			thumbnailTimes.length <= 0 ||
			visibleRange.end < visibleRange.start
		) {
			return;
		}

		const pendingByKey = new Map<string, { time: number }>();
		for (let index = visibleRange.start; index <= visibleRange.end; index++) {
			const thumbnailTime = thumbnailTimes[index];
			if (!thumbnailTime) continue;
			const { key, time } = thumbnailTime;
			if (!processedRef.current.has(key)) {
				pendingByKey.set(key, { time });
			}
		}
		const pending = Array.from(pendingByKey, ([key, value]) => ({
			key,
			time: value.time,
		}));
		if (pending.length === 0) return;

		let cancelled = false;
		let video: HTMLVideoElement | null = null;

		const cancelIdle = scheduleIdle(() => {
			void (async () => {
				video = document.createElement("video");
				video.crossOrigin = "anonymous";
				video.muted = true;
				video.playsInline = true;
				video.preload = "metadata";
				video.src = videoSrc;
				video.load();

				const hasMetadata = await waitForVideoMetadata(video);
				if (cancelled || !hasMetadata) {
					releaseThumbnailVideo(video);
					video = null;
					return;
				}

				const safeSourceDuration = Number.isFinite(video.duration)
					? Math.min(video.duration, sourceDuration)
					: sourceDuration;
				let frameBatch: Record<string, TimelineThumbnailFrame> = {};
				let frameBatchSize = 0;
				const flushFrameBatch = () => {
					if (frameBatchSize === 0) return;
					const nextBatch = frameBatch;
					frameBatch = {};
					frameBatchSize = 0;
					setFrames((current) => {
						let changed = false;
						const nextFrames = { ...current };
						for (const [key, frame] of Object.entries(nextBatch)) {
							if (nextFrames[key]?.src === frame.src) continue;
							nextFrames[key] = frame;
							changed = true;
						}
						return changed ? nextFrames : current;
					});
				};

				for (const item of pending) {
					if (cancelled) break;
					const time = Math.min(item.time, safeSourceDuration);
					const seeked = await seekVideoForThumbnail(video, time);
					if (cancelled) break;

					processedRef.current.add(item.key);
					if (seeked) {
						const frame = captureVideoFrameDataUrl({
							video,
							width: TIMELINE_THUMBNAIL_WIDTH,
							height: TIMELINE_THUMBNAIL_HEIGHT,
							quality: 0.55,
						});
						if (frame) {
							frameBatch[item.key] = { src: frame, time };
							frameBatchSize += 1;
							if (frameBatchSize >= THUMBNAIL_FRAME_BATCH_SIZE) {
								flushFrameBatch();
							}
						}
					}

					await waitForNextFrame();
				}

				if (!cancelled) {
					flushFrameBatch();
				}

				releaseThumbnailVideo(video);
				video = null;
			})();
		});

		return () => {
			cancelled = true;
			cancelIdle();
			releaseThumbnailVideo(video);
			video = null;
		};
	}, [
		enabled,
		sourceDuration,
		thumbnailTimes,
		videoSrc,
		visibleRange.end,
		visibleRange.start,
	]);

	return frames;
}

export function EditVideoClient({
	video,
	chapters,
	sourceChapters,
	hasExistingEdits,
	initialEditSpec,
	playbackSrc,
	usesOriginalSource,
	sourceSha256 = null,
}: {
	video: EditableVideo;
	chapters: { title: string; start: number }[];
	sourceChapters?: { title: string; start: number }[] | null;
	hasExistingEdits: boolean;
	initialEditSpec: VideoEditSpec;
	playbackSrc: string;
	usesOriginalSource: boolean;
	sourceSha256?: string | null;
}) {
	const router = useRouter();
	const [isPreparingTranscript, setIsPreparingTranscript] = useState(false);
	const editReadiness = useEditReadiness(
		video.id,
		true,
		JSON.stringify([video.transcriptionStatus, playbackSrc]),
	);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const timelineRef = useRef<HTMLDivElement | null>(null);
	const dockRef = useRef<HTMLElement | null>(null);
	const scrollContainerRef = useRef<HTMLDivElement | null>(null);
	const playheadOverlayRef = useRef<HTMLDivElement | null>(null);
	const stateRef = useRef<VideoTimelineState>(
		createTimelineStateFromEditSpec(initialEditSpec),
	);
	const dragDraftRef = useRef<VideoTimelineState | null>(null);
	// While trimming a clip edge we scrub the <video> to preview the edge frame
	// but deliberately leave the timeline cursor where the user paused it.
	const previewWithoutPlayheadRef = useRef(false);
	const playheadRef = useRef(0);
	const pendingPlayheadRef = useRef<number | null>(null);
	const playheadFrameRef = useRef(0);
	const pendingVideoSeekRef = useRef<number | null>(null);
	const videoSeekFrameRef = useRef(0);
	const zoomRef = useRef(1);
	const preferenceRef = useRef<ViewportPreference>({ kind: "fit" });
	const viewportWidthRef = useRef(1);
	const viewportIntentRef = useRef(0);
	const followSuspendedRef = useRef(false);
	const expectedScrollRef = useRef<number | null>(null);
	const pendingAnchorRef = useRef<{
		sourceTime: number;
		screenX: number;
		intent: number;
	} | null>(null);
	const renderedScaleRef = useRef<{ pps: number; scrollLeft: number } | null>(
		null,
	);
	const refreshOriginalSource = useCallback(async () => {
		const result = await getVideoDownloadInfo(video.id, "original");
		return result.success ? result.downloadUrl : null;
	}, [video.id]);
	const activePlaybackSrc = useRenewingPlaybackSource({
		initialSrc: playbackSrc,
		enabled: usesOriginalSource,
		videoRef,
		refresh: refreshOriginalSource,
	});
	const [isSaving, setIsSaving] = useState(false);
	const [waitingForRelocation, setWaitingForRelocation] = useState(false);
	const thumbnailCount = useThumbnailCount(timelineRef, !isSaving);
	const draftStorageKey = useMemo(
		() => getTimelineDraftKey(video.id),
		[video.id],
	);
	const initialState = useMemo(
		() => createTimelineStateFromEditSpec(initialEditSpec),
		[initialEditSpec],
	);
	const [history, setHistory] = useState<TimelineHistory>(() =>
		createTimelineHistory(initialState),
	);
	const [hydratedDraftKey, setHydratedDraftKey] = useState<string | null>(null);
	const [draftState, setDraftState] = useState<VideoTimelineState | null>(null);
	const [activeHandle, setActiveHandle] = useState<DragHandle | null>(null);
	const [playhead, setPlayhead] = useState(0);
	const [isPlaying, setIsPlaying] = useState(false);
	const [viewportPreference, setViewportPreference] =
		useState<ViewportPreference>({ kind: "fit" });
	const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);
	const [timelineViewportWidth, setTimelineViewportWidth] = useState(1);
	const [hideWaveform, setHideWaveform] = useState(false);
	const [dockHeightPx, setDockHeightPx] = useState(0);
	const [waveformPairs, setWaveformPairs] = useState<PeakPair[] | null>(null);
	const [waveformNoAudio, setWaveformNoAudio] = useState(false);
	const [hoverFraction, setHoverFraction] = useState<number | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		let cancelled = false;
		let timer = 0;
		setWaveformPairs(null);
		setWaveformNoAudio(false);
		const load = async (failure: number) => {
			try {
				const response = await fetch(waveformFetchUrl(video.id), {
					signal: controller.signal,
					cache: "no-store",
					credentials: "same-origin",
				});
				if (cancelled) return;
				if (response.status === 404) {
					const delay = nextWaveformRetryMs(failure);
					if (delay === null) return;
					timer = window.setTimeout(() => void load(failure + 1), delay);
					return;
				}
				if (!response.ok) return;
				const headerSha = response.headers.get("X-Cap-Source-Sha256");
				if (sourceSha256 && headerSha && headerSha !== sourceSha256) return;
				const decoded = decodePeaksObject(
					new Uint8Array(await response.arrayBuffer()),
					headerSha ?? sourceSha256 ?? "",
				);
				if (!decoded.ok || cancelled) return;
				setWaveformPairs(decoded.pairs);
				setWaveformNoAudio(decoded.noAudio);
			} catch {
				if (cancelled || controller.signal.aborted) return;
			}
		};
		void load(0);
		return () => {
			cancelled = true;
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [sourceSha256, video.id]);
	const [instantFinish, setInstantFinish] = useState<
		| {
				enabled: boolean;
				generation: number;
				draftVersion: number;
		  }
		| null
		| undefined
	>(undefined);
	const instantFinishRef = useRef(instantFinish);
	instantFinishRef.current = instantFinish;
	const settleTimerRef = useRef<{ clear: () => void } | null>(null);
	const settlePrepareRef = useRef<AbortController | null>(null);
	const settleRequestRef = useRef(0);
	const joinOnDoneRef = useRef(false);
	const flushPrepareRef = useRef<(() => void) | null>(null);
	const prepareOnceRef = useRef(createPrepareOnce());
	const prepareTrackRef = useRef<{
		spec: VideoEditSpec;
		requestId: number;
		controller: AbortController;
		sent: boolean;
		ready: boolean;
	} | null>(null);
	const savingRef = useRef(false);
	const doneControllerRef = useRef<AbortController | null>(null);
	const editorSnapshotRef = useRef({
		history,
		draftState,
		playhead,
	});
	editorSnapshotRef.current = { history, draftState, playhead };
	const publishSnapshotRef = useRef<{
		history: TimelineHistory;
		draftState: VideoTimelineState | null;
		playhead: number;
	} | null>(null);
	const [isRestoring, setIsRestoring] = useState(false);
	const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
	const committedState = history.entries[history.index] ?? initialState;
	const state = draftState ?? committedState;
	const editSpec = useMemo(() => getTimelineEditSpec(state), [state]);
	const baselineEditSpec = useMemo(
		() => getTimelineEditSpec(initialState),
		[initialState],
	);
	const hasTimelineChanges = useMemo(
		() => !areEditSpecDocumentsEquivalent(baselineEditSpec, editSpec),
		[baselineEditSpec, editSpec],
	);
	const hasDraftChanges = useMemo(
		() => !areTimelineStatesEquivalent(initialState, committedState),
		[committedState, initialState],
	);
	const keepRanges = useMemo(() => getTimelineKeepRanges(state), [state]);
	const segments = useMemo(() => getTimelineSegments(state), [state]);
	const visibleSegments = useMemo(
		() => segments.filter((segment) => !segment.deleted),
		[segments],
	);
	const timelineDisplaySplitPoints = useMemo(
		() => getTimelineDisplaySplitPoints(state),
		[state],
	);

	const timelineThumbnailUrl = useTimelineCoverThumbnail(video.id);
	const visibleThumbnailRange = useVisibleTimelineThumbnailRange({
		scrollContainerRef,
		timelineRef,
		thumbnailCount,
		active: !isSaving,
	});
	const thumbnailTimes = useMemo(
		() =>
			Array.from({ length: thumbnailCount }, (_, index) => {
				const time = getTimelineThumbnailTime(
					index,
					thumbnailCount,
					state.duration,
				);
				return {
					key: getTimelineThumbnailKey(time),
					time,
				};
			}),
		[thumbnailCount, state.duration],
	);
	const timelineFrames = useLazyTimelineThumbnails({
		videoSrc: activePlaybackSrc,
		sourceDuration: state.duration,
		thumbnailTimes,
		visibleRange: visibleThumbnailRange,
		enabled:
			!isSaving && !isPlaying && activeHandle === null && draftState === null,
	});
	const timelineFrameList = useMemo(
		() => Object.values(timelineFrames),
		[timelineFrames],
	);
	const thumbnailSlots = useMemo(
		() =>
			thumbnailTimes.map(({ key, time }, index) => {
				const exactFrame = timelineFrames[key];
				const frame =
					exactFrame ?? getNearestTimelineFrame(timelineFrameList, time);
				return {
					key: `thumb-${index}`,
					src: frame?.src ?? timelineThumbnailUrl,
				};
			}),
		[thumbnailTimes, timelineFrameList, timelineFrames, timelineThumbnailUrl],
	);
	const canUndo = history.index > 0;
	const canRedo = history.index < history.entries.length - 1;
	const visibleSegmentCount = visibleSegments.length;
	const trimStartPct = getTimePercent(state.trimStart, state.duration);
	const trimEndPct = getTimePercent(state.trimEnd, state.duration);
	// Clamp the rendered cursor against the COMMITTED trim bounds, not the live
	// draft: while dragging a trim edge past the paused cursor, the cursor must
	// stay put rather than get dragged along with the moving handle.
	const clampedPlayhead = Math.min(
		Math.max(playhead, committedState.trimStart),
		committedState.trimEnd,
	);
	const isTrimming = activeHandle !== null || draftState !== null;
	const outputDuration = useMemo(
		() => getEditSpecOutputDuration(editSpec),
		[editSpec],
	);
	const hasOutputEdits = outputDuration < state.duration;
	const { chaptersUrl, playbackChapters } = useEditorChapterPreview({
		chapters,
		sourceChapters,
		initialEditSpec,
		editSpec,
	});
	const outputPlayhead = useMemo(() => {
		const mapped = mapSourceTimeToOutputTime(clampedPlayhead, editSpec);
		if (mapped !== null) return mapped;
		let cumulative = 0;
		for (const range of editSpec.keepRanges) {
			if (clampedPlayhead < range.start) return cumulative;
			if (clampedPlayhead <= range.end) {
				return cumulative + (clampedPlayhead - range.start);
			}
			cumulative += range.end - range.start;
		}
		return cumulative;
	}, [clampedPlayhead, editSpec]);

	useEffect(() => {
		stateRef.current = state;
	}, [state]);

	useEffect(() => {
		playheadRef.current = playhead;
	}, [playhead]);

	const zoom = relativeZoomForPreference(
		viewportPreference,
		timelineViewportWidth,
		state.duration,
	);
	const editingPxPerSec = effectivePxPerSec(
		viewportPreference,
		timelineViewportWidth,
		state.duration,
	);
	const zoomLabel =
		viewportPreference.kind === "fit"
			? "Fit"
			: `${formatZoomMeasure(editingPxPerSec)} px/s`;
	const timelineTrackWidth =
		viewportPreference.kind === "density" &&
		editingPxPerSec > 0 &&
		state.duration > 0 &&
		Number.isFinite(editingPxPerSec * state.duration)
			? `${editingPxPerSec * state.duration}px`
			: "100%";
	const sliderStop = sliderStopForPreference(
		viewportPreference,
		timelineViewportWidth,
		state.duration,
	);
	const densityFloor = fitFloorPxPerSec(timelineViewportWidth, state.duration);
	const zoomInDisabled = !(
		effectiveMaxPxPerSec(timelineViewportWidth, state.duration) > densityFloor
	);

	useEffect(() => {
		zoomRef.current = zoom;
		preferenceRef.current = viewportPreference;
	}, [viewportPreference, zoom]);

	useEffect(() => {
		const draftStorage = getTimelineDraftStorage();
		const restoredState = draftStorage
			? readTimelineDraft(
					draftStorage,
					draftStorageKey,
					initialState.duration,
					initialEditSpec,
				)
			: null;
		const nextState = restoredState ?? initialState;
		setDraftState(null);
		dragDraftRef.current = null;
		setHistory(createTimelineHistory(nextState));
		setPlayhead(nextState.trimStart);
		setHydratedDraftKey(draftStorageKey);
	}, [draftStorageKey, initialEditSpec, initialState]);

	useEffect(() => {
		if (hydratedDraftKey !== draftStorageKey) return;
		const draftStorage = getTimelineDraftStorage();
		if (!draftStorage) return;
		if (hasDraftChanges) {
			writeTimelineDraft(
				draftStorage,
				draftStorageKey,
				initialState.duration,
				committedState,
				initialEditSpec,
			);
			return;
		}
		clearTimelineDraft(draftStorage, draftStorageKey);
	}, [
		committedState,
		draftStorageKey,
		hasDraftChanges,
		hydratedDraftKey,
		initialEditSpec,
		initialState.duration,
	]);

	const setPlayheadOnFrame = useCallback((time: number, immediate = false) => {
		if (immediate) {
			if (playheadFrameRef.current !== 0) {
				cancelAnimationFrame(playheadFrameRef.current);
				playheadFrameRef.current = 0;
			}
			pendingPlayheadRef.current = null;
			setPlayhead(time);
			return;
		}

		pendingPlayheadRef.current = time;
		if (playheadFrameRef.current !== 0) return;

		playheadFrameRef.current = requestAnimationFrame(() => {
			playheadFrameRef.current = 0;
			const nextTime = pendingPlayheadRef.current;
			pendingPlayheadRef.current = null;
			if (nextTime !== null) setPlayhead(nextTime);
		});
	}, []);

	const setVideoTimeOnFrame = useCallback((time: number, immediate = false) => {
		const applySeek = () => {
			const videoElement = videoRef.current;
			const nextTime = pendingVideoSeekRef.current;
			pendingVideoSeekRef.current = null;
			if (!videoElement || nextTime === null) return;
			if (Math.abs(videoElement.currentTime - nextTime) > 0.01) {
				videoElement.currentTime = nextTime;
			}
		};

		pendingVideoSeekRef.current = time;

		if (immediate) {
			if (videoSeekFrameRef.current !== 0) {
				cancelAnimationFrame(videoSeekFrameRef.current);
				videoSeekFrameRef.current = 0;
			}
			applySeek();
			return;
		}

		if (videoSeekFrameRef.current !== 0) return;

		videoSeekFrameRef.current = requestAnimationFrame(() => {
			videoSeekFrameRef.current = 0;
			applySeek();
		});
	}, []);

	useEffect(
		() => () => {
			doneControllerRef.current?.abort();
			if (playheadFrameRef.current !== 0) {
				cancelAnimationFrame(playheadFrameRef.current);
			}
			if (videoSeekFrameRef.current !== 0) {
				cancelAnimationFrame(videoSeekFrameRef.current);
			}
		},
		[],
	);

	useEffect(() => {
		const node = scrollContainerRef.current;
		if (!node) return;
		let frame = 0;
		const measure = () => {
			frame = 0;
			const nextWidth = Math.max(1, node.clientWidth);
			const previous = viewportWidthRef.current;
			if (nextWidth !== previous && previous > 1 && nextWidth > 1) {
				const duration = stateRef.current.duration;
				const rendered = renderedScaleRef.current;
				const pps =
					rendered && rendered.pps > 0
						? rendered.pps
						: effectivePxPerSec(preferenceRef.current, previous, duration);
				const timeline = timelineRef.current;
				const trackWidth = timeline
					? timeline.getBoundingClientRect().width
					: 0;
				const maxScroll = Math.max(0, trackWidth - nextWidth);
				const liveScroll = node.scrollLeft;
				const scrollLeft =
					rendered &&
					nextWidth > previous &&
					rendered.scrollLeft > maxScroll + 1 &&
					rendered.scrollLeft <= Math.max(0, trackWidth - previous) + 1 &&
					Math.abs(liveScroll - maxScroll) < 1
						? rendered.scrollLeft
						: liveScroll;
				const center = pps > 0 ? (scrollLeft + previous / 2) / pps : 0;
				const intent = viewportIntentRef.current + 1;
				viewportIntentRef.current = intent;
				pendingAnchorRef.current = {
					sourceTime: center,
					screenX: nextWidth / 2,
					intent,
				};
			}
			viewportWidthRef.current = nextWidth;
			setTimelineScrollLeft(node.scrollLeft);
			setTimelineViewportWidth(nextWidth);
			if (!pendingAnchorRef.current) {
				const duration = stateRef.current.duration;
				const pps = effectivePxPerSec(
					preferenceRef.current,
					nextWidth,
					duration,
				);
				if (pps > 0) {
					renderedScaleRef.current = { pps, scrollLeft: node.scrollLeft };
				}
			}
		};
		const schedule = () => {
			if (frame !== 0) return;
			frame = requestAnimationFrame(measure);
		};
		const noteUserScroll = () => {
			const expected = expectedScrollRef.current;
			if (expected !== null && Math.abs(node.scrollLeft - expected) < 1) {
				return;
			}
			if (node.clientWidth !== viewportWidthRef.current) return;
			const rendered = renderedScaleRef.current;
			if (rendered) rendered.scrollLeft = node.scrollLeft;
			followSuspendedRef.current = true;
			viewportIntentRef.current += 1;
		};
		measure();
		node.addEventListener("scroll", noteUserScroll, { passive: true });
		node.addEventListener("scroll", schedule, { passive: true });
		const observer = new ResizeObserver(schedule);
		observer.observe(node);
		return () => {
			node.removeEventListener("scroll", noteUserScroll);
			node.removeEventListener("scroll", schedule);
			observer.disconnect();
			if (frame !== 0) cancelAnimationFrame(frame);
		};
	}, []);

	useEffect(() => {
		if (isSaving) return;
		const node = dockRef.current;
		if (!node) return;
		const measure = () => {
			const next = node.getBoundingClientRect().height;
			if (!Number.isFinite(next) || next <= 0) return;
			setDockHeightPx((current) => (current === next ? current : next));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [isSaving]);

	const updatePlayheadOverlay = useCallback(() => {
		const container = scrollContainerRef.current;
		const overlay = playheadOverlayRef.current;
		if (!container || !overlay) return;
		const fraction = state.duration > 0 ? clampedPlayhead / state.duration : 0;
		const x = fraction * container.scrollWidth - container.scrollLeft;
		overlay.style.transform = `translate3d(${x}px, 0, 0) translateX(-50%)`;
	}, [clampedPlayhead, state.duration]);

	const commitState = useCallback((nextState: VideoTimelineState) => {
		setDraftState(null);
		dragDraftRef.current = null;
		setHistory((currentHistory) =>
			pushTimelineHistory(currentHistory, nextState),
		);
	}, []);

	const handleUndo = useCallback(() => {
		setDraftState(null);
		setHistory(undoTimelineHistory);
	}, []);

	const handleRedo = useCallback(() => {
		setDraftState(null);
		setHistory(redoTimelineHistory);
	}, []);

	const handleTranscriptDelete = useCallback(
		(ranges: { start: number; end: number }[]) => {
			const nextState = deleteTimelineRanges(stateRef.current, ranges);
			const nextEditSpec = getTimelineEditSpec(nextState);
			const nextPlayableTime =
				findNextPlayableTime(playheadRef.current, nextEditSpec) ??
				nextEditSpec.keepRanges.at(-1)?.end ??
				0;
			commitState(nextState);
			setPlayheadOnFrame(nextPlayableTime, true);
			setVideoTimeOnFrame(nextPlayableTime, true);
		},
		[commitState, setPlayheadOnFrame, setVideoTimeOnFrame],
	);

	const handleTranscriptRestore = useCallback(
		(ranges: { start: number; end: number }[]) => {
			const nextState = restoreTimelineRanges(stateRef.current, ranges);
			commitState(nextState);
		},
		[commitState],
	);

	const handleSetAutoCutLayer = useCallback(
		(kind: keyof VideoAutoCuts, layer: VideoAutoCuts[keyof VideoAutoCuts]) => {
			const nextState =
				kind === "silence"
					? setTimelineAutoCutLayer(
							stateRef.current,
							"silence",
							layer as VideoAutoCuts["silence"],
						)
					: setTimelineAutoCutLayer(
							stateRef.current,
							"fillers",
							layer as VideoAutoCuts["fillers"],
						);
			const nextEditSpec = getTimelineEditSpec(nextState);
			const nextPlayableTime =
				findNextPlayableTime(playheadRef.current, nextEditSpec) ??
				nextEditSpec.keepRanges.at(-1)?.end ??
				0;
			commitState(nextState);
			setPlayheadOnFrame(nextPlayableTime, true);
			setVideoTimeOnFrame(nextPlayableTime, true);
		},
		[commitState, setPlayheadOnFrame, setVideoTimeOnFrame],
	);

	const handleInitializeAutoCuts = useCallback(
		(autoCuts: VideoAutoCuts) => {
			const withSilence = setTimelineAutoCutLayer(
				stateRef.current,
				"silence",
				autoCuts.silence,
			);
			const nextState = setTimelineAutoCutLayer(
				withSilence,
				"fillers",
				autoCuts.fillers,
			);
			const nextEditSpec = getTimelineEditSpec(nextState);
			const nextPlayableTime =
				findNextPlayableTime(playheadRef.current, nextEditSpec) ??
				nextEditSpec.keepRanges.at(-1)?.end ??
				0;
			commitState(nextState);
			setPlayheadOnFrame(nextPlayableTime, true);
			setVideoTimeOnFrame(nextPlayableTime, true);
		},
		[commitState, setPlayheadOnFrame, setVideoTimeOnFrame],
	);

	// Loom-style: cut the clip at the current playhead into two independent clips.
	const handleSplit = useCallback(() => {
		commitState(splitTimelineAt(stateRef.current, playheadRef.current));
	}, [commitState]);

	const removeSplitAtIndex = useCallback(
		(index: number) => {
			commitState(removeTimelineDisplaySplitPoint(stateRef.current, index));
		},
		[commitState],
	);

	const activeSegmentAtPlayhead = useMemo(
		() =>
			visibleSegments.find(
				(segment) =>
					playhead >= segment.start - 0.001 && playhead <= segment.end + 0.001,
			),
		[playhead, visibleSegments],
	);
	const canDeleteSegment =
		activeSegmentAtPlayhead !== undefined && visibleSegmentCount > 1;

	const handleDelete = useCallback(() => {
		if (!activeSegmentAtPlayhead) return;
		if (visibleSegments.length <= 1) return;
		const withSelection = selectTimelineSegment(
			stateRef.current,
			activeSegmentAtPlayhead.id,
		);
		commitState(deleteSelectedTimelineSegment(withSelection));
	}, [activeSegmentAtPlayhead, commitState, visibleSegments.length]);

	const handleBackspace = useCallback(() => {
		const SPLIT_SNAP = 0.25;
		const splitAtPlayheadIndex = timelineDisplaySplitPoints.findIndex(
			(splitPoint) =>
				splitPoint.removable &&
				splitPoint.sourceTimes.some(
					(sourceTime) => Math.abs(sourceTime - playhead) <= SPLIT_SNAP,
				),
		);
		if (splitAtPlayheadIndex !== -1) {
			commitState(
				removeTimelineDisplaySplitPoint(stateRef.current, splitAtPlayheadIndex),
			);
			return;
		}
		handleDelete();
	}, [commitState, handleDelete, playhead, timelineDisplaySplitPoints]);

	useEffect(() => {
		let cancelled = false;
		void getEditorInstantFinishState({
			videoId: video.id,
			ownerId: video.ownerId,
		})
			.then((state) => {
				if (!cancelled) setInstantFinish(state);
			})
			.catch(() => {
				if (!cancelled) setInstantFinish(null);
			});
		return () => {
			cancelled = true;
		};
	}, [video.id, video.ownerId]);

	useEffect(() => {
		if (!instantFinish?.enabled || isSaving) return;
		const spec = editSpec;
		const key = prepareSpecKey(normalizeVideoEditSpec(spec));
		const once = prepareOnceRef.current;
		once.forgetIfDifferent(key);
		if (
			once.sentKey() === key &&
			prepareTrackRef.current &&
			!prepareTrackRef.current.controller.signal.aborted
		) {
			return;
		}
		joinOnDoneRef.current = false;
		const started = nextSettlePrepare(
			settlePrepareRef.current,
			settleRequestRef.current,
		);
		settleRequestRef.current = started.requestId;
		settlePrepareRef.current = started.controller;
		const requestId = started.requestId;
		prepareTrackRef.current = {
			spec,
			requestId,
			controller: started.controller,
			sent: false,
			ready: false,
		};
		const fire = () => {
			if (savingRef.current) return;
			if (prepareTrackRef.current?.requestId !== requestId) return;
			if (prepareTrackRef.current.sent) return;
			prepareTrackRef.current.sent = true;
			const current = instantFinishRef.current;
			if (!current?.enabled) return;
			const draftStorage = getTimelineDraftStorage();
			const draftSession = readOrCreateDraftSession(draftStorage, video.id);
			void postRevisionRoute<{ revisionId: string; generation: number }>(
				"/api/video/revision/prepare",
				{
					videoId: video.id,
					editSpec: spec,
					expectedEditSpec: initialEditSpec,
					baseGeneration: current.generation ?? 0,
					draftVersion: (current.draftVersion ?? 0) + 1,
					draftSession,
				},
				started.controller.signal,
			)
				.then((prepared) => {
					if (!acceptSettledPrepare(requestId, settleRequestRef.current)) {
						return;
					}
					if (savingRef.current) return;
					if (prepareTrackRef.current?.requestId === requestId) {
						prepareTrackRef.current.ready = true;
					}
					setInstantFinish((existing) =>
						existing
							? {
									...existing,
									generation: prepared.generation,
								}
							: existing,
					);
				})
				.catch(() => undefined);
		};
		once.arm(key, SETTLE_PREPARE_DEBOUNCE_MS, fire);
		flushPrepareRef.current = () => {
			once.flush(key, fire);
		};
		settleTimerRef.current = {
			clear: () => {
				once.cancelTimer();
				if (!joinOnDoneRef.current && once.sentKey() !== key) {
					started.controller.abort();
				}
			},
		};
		return () => {
			once.cancelTimer();
			flushPrepareRef.current = null;
			if (!joinOnDoneRef.current && once.sentKey() !== key) {
				started.controller.abort();
			}
			if (once.sentKey() !== key) settleRequestRef.current += 1;
			if (
				settlePrepareRef.current === started.controller &&
				!joinOnDoneRef.current &&
				once.sentKey() !== key
			) {
				settlePrepareRef.current = null;
			}
			settleTimerRef.current = null;
		};
	}, [editSpec, initialEditSpec, instantFinish?.enabled, isSaving, video.id]);

	const prepareOnPointerDown = useCallback(() => {
		if (!instantFinishRef.current?.enabled || savingRef.current) return;
		const key = prepareSpecKey(normalizeVideoEditSpec(editSpec));
		const once = prepareOnceRef.current;
		once.cancelTimer();
		if (once.sentKey() === key) return;
		const flush = flushPrepareRef.current;
		if (flush) {
			flush();
			return;
		}
		once.flush(key, () => {
			const started = nextSettlePrepare(
				settlePrepareRef.current,
				settleRequestRef.current,
			);
			settleRequestRef.current = started.requestId;
			settlePrepareRef.current = started.controller;
			prepareTrackRef.current = {
				spec: editSpec,
				requestId: started.requestId,
				controller: started.controller,
				sent: true,
				ready: false,
			};
			const current = instantFinishRef.current;
			if (!current?.enabled) return;
			const draftStorage = getTimelineDraftStorage();
			const draftSession = readOrCreateDraftSession(draftStorage, video.id);
			void postRevisionRoute<{ revisionId: string; generation: number }>(
				"/api/video/revision/prepare",
				{
					videoId: video.id,
					editSpec,
					expectedEditSpec: initialEditSpec,
					baseGeneration: current.generation ?? 0,
					draftVersion: (current.draftVersion ?? 0) + 1,
					draftSession,
				},
				started.controller.signal,
			)
				.then((prepared) => {
					if (
						!acceptSettledPrepare(started.requestId, settleRequestRef.current)
					) {
						return;
					}
					if (savingRef.current) return;
					if (prepareTrackRef.current?.requestId === started.requestId) {
						prepareTrackRef.current.ready = true;
					}
					setInstantFinish((existing) =>
						existing
							? { ...existing, generation: prepared.generation }
							: existing,
					);
				})
				.catch(() => undefined);
		});
	}, [editSpec, initialEditSpec, video.id]);

	const handleDone = useCallback(async () => {
		const key = prepareSpecKey(normalizeVideoEditSpec(editSpec));
		if (prepareOnceRef.current.sentKey() !== key) {
			flushPrepareRef.current?.();
		}
		prepareOnceRef.current.cancelTimer();
		const track = prepareTrackRef.current;
		const join = shouldJoinInflightPrepare({
			inflightMatches: Boolean(
				track && areEditSpecDocumentsEquivalent(track.spec, editSpec),
			),
			aborted: track?.controller.signal.aborted === true,
			sent: track?.sent === true,
		});
		joinOnDoneRef.current = join;
		const fenced = beginDoneFence(
			settleRequestRef.current,
			settlePrepareRef.current,
			{ join },
		);
		settleRequestRef.current = fenced.requestId;
		settlePrepareRef.current = fenced.controller;
		settleTimerRef.current?.clear();
		settleTimerRef.current = null;
		if (isSaving) return;
		const draftStorage = getTimelineDraftStorage();
		if (!hasTimelineChanges) {
			if (draftStorage) clearTimelineDraft(draftStorage, draftStorageKey);
			router.push(`/s/${video.id}`);
			return;
		}
		if (doneRoute(instantFinish) === "wait") return;
		const controller = new AbortController();
		doneControllerRef.current = controller;
		const { signal } = controller;
		const submittedState = stateRef.current;
		publishSnapshotRef.current = {
			history: editorSnapshotRef.current.history,
			draftState: editorSnapshotRef.current.draftState,
			playhead: editorSnapshotRef.current.playhead,
		};
		savingRef.current = true;
		setWaitingForRelocation(false);
		setIsSaving(true);
		const restoreEditor = () => {
			const snapshot = publishSnapshotRef.current;
			savingRef.current = false;
			if (snapshot && stateRef.current === submittedState) {
				setHistory(snapshot.history);
				setDraftState(snapshot.draftState);
				setPlayhead(snapshot.playhead);
			}
			setWaitingForRelocation(false);
			setIsSaving(false);
		};
		try {
			const draftStorage = getTimelineDraftStorage();
			const draftSession = readOrCreateDraftSession(draftStorage, video.id);
			if (!instantFinish?.enabled) {
				await saveVideoEdits(video.id, editSpec, initialEditSpec);
				signal.throwIfAborted();
				if (draftStorage) clearTimelineDraft(draftStorage, draftStorageKey);
				router.push(`/s/${video.id}`);
				router.refresh();
				return;
			}
			let publicationState = instantFinish;
			let expectedEditSpec = initialEditSpec;
			const submittedDraftVersion = (instantFinish.draftVersion ?? 0) + 1;
			const submittedDraft = draftStorage?.getItem(draftStorageKey) ?? null;
			let expectedDraftSession: string | undefined;
			const published = await publishDoneWithRetry(
				(signal) =>
					postRevisionRoute<{
						success: boolean;
						revisionId: string;
						generation: number;
						playback: {
							playlistUrl: string;
							grantExpiresAt: number;
							revisionMetadata: Parameters<
								typeof stashInstantFinishPlayback
							>[0]["revisionMetadata"];
						} | null;
					}>(
						"/api/video/revision/publish",
						{
							videoId: video.id,
							editSpec,
							expectedEditSpec,
							baseGeneration: publicationState.generation ?? 0,
							draftVersion: (publicationState.draftVersion ?? 0) + 1,
							draftSession,
							...(expectedDraftSession !== undefined && {
								expectedDraftSession,
							}),
						},
						signal,
					),
				async (error) => {
					if (
						error instanceof Error &&
						error.message === "Editor-open warm expired. Reopen the editor."
					) {
						const warmed = await rewarmEditorSource(video.id);
						signal.throwIfAborted();
						if (!warmed.success) throw new Error(warmed.error);
					}
					const fresh = await getEditorInstantFinishState({
						videoId: video.id,
						ownerId: video.ownerId,
					});
					signal.throwIfAborted();
					if (fresh.draftSession && fresh.draftSession !== draftSession) {
						throw error instanceof Error && error.message
							? error
							: new Error(
									"This video was edited in another session. Reload before publishing.",
								);
					}
					publicationState = fresh;
					// Only rebase the V1 -> V2 uncut bootstrap, never a newer edit.
					const refreshedSpec = fresh.expectedEditSpec;
					if (
						initialEditSpec.version === 1 &&
						refreshedSpec?.version === 2 &&
						!refreshedSpec.autoCuts.silence.enabled &&
						!refreshedSpec.autoCuts.fillers.enabled &&
						refreshedSpec.autoCuts.silence.ranges.length === 0 &&
						refreshedSpec.autoCuts.fillers.ranges.length === 0 &&
						areEditSpecsEquivalent(
							initialEditSpec,
							createIdentityEditSpec(initialEditSpec.sourceDuration),
						) &&
						areEditSpecsEquivalent(refreshedSpec, initialEditSpec) &&
						areEditSpecsEquivalent(
							{ ...refreshedSpec, keepRanges: refreshedSpec.manualKeepRanges },
							initialEditSpec,
						)
					) {
						expectedEditSpec = refreshedSpec;
					}
					expectedDraftSession = fresh.draftSession ?? "";
					setInstantFinish(publicationState);
				},
				() => setWaitingForRelocation(true),
				{
					signal,
					beforeRetry: () => {
						const localDraft = draftStorage?.getItem(draftStorageKey) ?? null;
						const draftVersion = JSON.parse(localDraft ?? "null")?.draftVersion;
						if (
							localDraft !== submittedDraft ||
							(Number.isSafeInteger(draftVersion) &&
								draftVersion > submittedDraftVersion) ||
							stateRef.current !== submittedState
						) {
							throw new Error(
								"Draft changed while publishing. Review the editor before trying Done again.",
							);
						}
					},
				},
			);
			signal.throwIfAborted();
			if (published.success) {
				if (published.playback && typeof sessionStorage !== "undefined") {
					stashInstantFinishPlayback(
						{
							videoId: video.id,
							revisionId: published.revisionId,
							generation: published.generation,
							playlistUrl: published.playback.playlistUrl,
							grantExpiresAt: published.playback.grantExpiresAt,
							revisionMetadata: published.playback.revisionMetadata,
						},
						sessionStorage,
					);
					prefetchInstantFinishPlaylist(published.playback.playlistUrl);
				}
				if (draftStorage) clearTimelineDraft(draftStorage, draftStorageKey);
				router.push(`/s/${video.id}`);
				return;
			}
			toast.error("Failed to publish edit");
			restoreEditor();
		} catch (error) {
			if (signal.aborted) return;
			const status =
				typeof error === "object" &&
				error !== null &&
				"status" in error &&
				typeof error.status === "number"
					? error.status
					: 0;
			const message =
				error instanceof Error
					? error.message
					: typeof error === "object" &&
							error !== null &&
							"message" in error &&
							typeof error.message === "string" &&
							error.message.length > 0
						? error.message
						: "Failed to start video edit";
			toast.error(
				/Failed to find Server Action/i.test(message)
					? "Cap was updated. Reload the page to continue — edits saved in this browser will be restored."
					: status === 409 && /source.*not ready/i.test(message)
						? "Still preparing for editing — try again in a moment."
						: message,
			);
			restoreEditor();
		}
	}, [
		draftStorageKey,
		editSpec,
		hasTimelineChanges,
		initialEditSpec,
		instantFinish,
		isSaving,
		router,
		video.id,
		video.ownerId,
	]);

	const handleCancel = useCallback(() => {
		const draftStorage = getTimelineDraftStorage();
		if (draftStorage) clearTimelineDraft(draftStorage, draftStorageKey);
		navigateWithTransition("edit-exit", () => router.push(`/s/${video.id}`));
	}, [draftStorageKey, router, video.id]);

	const resetTimeline = useCallback(() => {
		const draftStorage = getTimelineDraftStorage();
		setDraftState(null);
		dragDraftRef.current = null;
		setHistory(createTimelineHistory(initialState));
		setPlayhead(initialState.trimStart);
		if (draftStorage) clearTimelineDraft(draftStorage, draftStorageKey);
	}, [draftStorageKey, initialState]);

	const canRestore = hasExistingEdits || hasTimelineChanges;

	const handleRestore = useCallback(async () => {
		if (isRestoring || isSaving) return;
		const route = restoreRoute(instantFinish);
		if (route === "wait") return;

		if (!hasExistingEdits) {
			resetTimeline();
			setShowRestoreConfirm(false);
			return;
		}
		if (route === "editor") {
			setDraftState(null);
			dragDraftRef.current = null;
			const uncut = createTimelineStateFromEditSpec(
				restoredEditorSpec(initialEditSpec.sourceDuration),
			);
			commitState(uncut);
			setPlayhead(uncut.trimStart);
			setShowRestoreConfirm(false);
			return;
		}

		setIsRestoring(true);
		try {
			await restoreVideoToOriginal(video.id);
			resetTimeline();
			setShowRestoreConfirm(false);
			router.push(`/s/${video.id}`);
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to restore video",
			);
			setIsRestoring(false);
		}
	}, [
		commitState,
		hasExistingEdits,
		initialEditSpec,
		instantFinish,
		isRestoring,
		isSaving,
		resetTimeline,
		router,
		video.id,
	]);

	const seekTo = useCallback(
		(
			time: number,
			immediate = false,
			direction: "forward" | "backward" = "forward",
		) => {
			const current = stateRef.current;
			const { trimStart, trimEnd } = current;
			const trimmedTime = Math.min(Math.max(time, trimStart), trimEnd);
			const spec = getTimelineEditSpec(current);
			const playable =
				(direction === "backward"
					? findPreviousPlayableTime(trimmedTime, spec)
					: null) ??
				findNextPlayableTime(trimmedTime, spec) ??
				spec.keepRanges.at(-1)?.end ??
				trimStart;
			const bounded = Math.min(Math.max(playable, trimStart), trimEnd);
			const clamped = getClampedVideoTime(bounded, videoRef.current, trimEnd);
			const next = Math.min(Math.max(clamped, trimStart), trimEnd);
			followSuspendedRef.current = false;
			setVideoTimeOnFrame(next, immediate);
			setPlayheadOnFrame(next, immediate);
		},
		[setPlayheadOnFrame, setVideoTimeOnFrame],
	);

	const togglePlayPause = useCallback(() => {
		const videoElement = videoRef.current;
		if (!videoElement) return;
		if (videoElement.paused) {
			void videoElement.play();
		} else {
			videoElement.pause();
		}
	}, []);

	const restoreCursorToPlayable = useCallback(
		(time: number, finalState: VideoTimelineState) => {
			const spec = getTimelineEditSpec(finalState);
			if (spec.keepRanges.length === 0) return;
			const target =
				findNextPlayableTime(time, spec) ??
				spec.keepRanges[spec.keepRanges.length - 1]?.end ??
				spec.keepRanges[0]?.start ??
				0;
			setVideoTimeOnFrame(target, true);
			setPlayheadOnFrame(target, true);
		},
		[setPlayheadOnFrame, setVideoTimeOnFrame],
	);

	const startClipEdgeDrag = useCallback(
		(
			clipId: string,
			edge: DragHandle,
			isOuter: boolean,
			event: React.PointerEvent<HTMLButtonElement>,
		) => {
			event.preventDefault();
			event.stopPropagation();
			const timeline = timelineRef.current;
			if (!timeline) return;

			if (isOuter) setActiveHandle(edge);
			const baseState = stateRef.current;
			const rect = timeline.getBoundingClientRect();
			const restorePlayhead = playheadRef.current;
			previewWithoutPlayheadRef.current = true;
			let draftFrameId = 0;
			let pendingClientX = event.clientX;
			const getTimeFromClientX = (clientX: number) =>
				getTimelineSourceTimeFromClientX(clientX, rect, baseState);
			const updateDraft = (clientX: number) => {
				const time = getTimeFromClientX(clientX);
				const nextState = trimTimelineClipEdge(baseState, clipId, edge, time);
				dragDraftRef.current = nextState;
				setDraftState(nextState);
				// Preview the frame at the trimmed edge, but leave the cursor put.
				const clamped = getClampedVideoTime(
					time,
					videoRef.current,
					baseState.duration,
				);
				setVideoTimeOnFrame(clamped);
			};
			const scheduleDraftUpdate = (clientX: number) => {
				pendingClientX = clientX;
				if (draftFrameId !== 0) return;
				draftFrameId = requestAnimationFrame(() => {
					draftFrameId = 0;
					updateDraft(pendingClientX);
				});
			};
			const handlePointerMove = (moveEvent: PointerEvent) => {
				scheduleDraftUpdate(moveEvent.clientX);
			};
			const handlePointerUp = (upEvent: PointerEvent) => {
				window.removeEventListener("pointermove", handlePointerMove);
				window.removeEventListener("pointerup", handlePointerUp);
				window.removeEventListener("pointercancel", handlePointerUp);
				if (draftFrameId !== 0) {
					cancelAnimationFrame(draftFrameId);
					draftFrameId = 0;
				}
				updateDraft(upEvent.clientX);
				previewWithoutPlayheadRef.current = false;
				setActiveHandle(null);
				const nextState = dragDraftRef.current;
				if (nextState) commitState(nextState);
				// Snap the cursor back to where the user paused, clamped into the
				// surviving footage so playback resumes from there.
				restoreCursorToPlayable(restorePlayhead, nextState ?? baseState);
			};

			updateDraft(event.clientX);
			window.addEventListener("pointermove", handlePointerMove);
			window.addEventListener("pointerup", handlePointerUp, { once: true });
			// pointercancel (touch interrupted, OS takeover) must run the same
			// teardown, else previewWithoutPlayheadRef stays true and the cursor
			// freezes for the rest of the session.
			window.addEventListener("pointercancel", handlePointerUp, { once: true });
		},
		[commitState, restoreCursorToPlayable, setVideoTimeOnFrame],
	);

	const writeTimelineScroll = useCallback((node: HTMLElement, left: number) => {
		const max = Math.max(0, node.scrollWidth - node.clientWidth);
		const next = Math.min(max, Math.max(0, left));
		expectedScrollRef.current = next;
		node.scrollLeft = next;
	}, []);

	const applyPendingAnchor = useCallback(
		(width: number, preference: ViewportPreference) => {
			const pending = pendingAnchorRef.current;
			const node = scrollContainerRef.current;
			if (!pending || !node || pending.intent !== viewportIntentRef.current)
				return;
			const duration = stateRef.current.duration;
			const pps = effectivePxPerSec(preference, width, duration);
			if (preference.kind === "fit" || !(pps > 0) || !(width > 0)) {
				writeTimelineScroll(node, 0);
				renderedScaleRef.current = {
					pps: pps > 0 ? pps : 0,
					scrollLeft: node.scrollLeft,
				};
				pendingAnchorRef.current = null;
				return;
			}
			const renderedWidth = timelineRef.current
				? timelineRef.current.getBoundingClientRect().width
				: 0;
			const expectedWidth = pps * duration;
			if (
				!(renderedWidth > 0) ||
				!Number.isFinite(expectedWidth) ||
				Math.abs(renderedWidth - expectedWidth) > 1
			) {
				return;
			}
			writeTimelineScroll(node, pending.sourceTime * pps - pending.screenX);
			renderedScaleRef.current = { pps, scrollLeft: node.scrollLeft };
			pendingAnchorRef.current = null;
		},
		[writeTimelineScroll],
	);

	const applyViewportPreference = useCallback(
		(next: ViewportPreference, anchorClientX?: number) => {
			const container = scrollContainerRef.current;
			const width =
				container && container.clientWidth > 0
					? container.clientWidth
					: timelineViewportWidth;
			const duration = stateRef.current.duration;
			let screenX = width / 2;
			if (container && anchorClientX !== undefined) {
				const rect = container.getBoundingClientRect();
				screenX = Math.min(
					Math.max(anchorClientX - rect.left, 0),
					Math.max(rect.width, 0),
				);
			}
			const pending = pendingAnchorRef.current;
			const correctionPending =
				pending !== null && pending.intent === viewportIntentRef.current;
			const rendered = renderedScaleRef.current;
			const timelineWidthPx = timelineRef.current
				? timelineRef.current.getBoundingClientRect().width
				: 0;
			const laidOut =
				Number.isFinite(timelineWidthPx) && timelineWidthPx > 1 && width > 1;
			const externalScroll =
				container !== null &&
				rendered !== null &&
				Math.abs(container.scrollLeft - rendered.scrollLeft) >= 1;
			const pointerMoved =
				pending !== null && Math.abs(screenX - pending.screenX) >= 1;
			let sourceTime = 0;
			let anchorScreen = screenX;
			if (!laidOut) {
				if (pending) {
					sourceTime = pending.sourceTime;
					anchorScreen = pending.screenX;
				}
			} else if (
				correctionPending &&
				pending &&
				!pointerMoved &&
				!externalScroll
			) {
				sourceTime = pending.sourceTime;
				anchorScreen = pending.screenX;
			} else {
				const oldPps =
					rendered && rendered.pps > 0
						? rendered.pps
						: duration > 0 && timelineWidthPx > 0
							? timelineWidthPx / duration
							: 0;
				const scrollLeft = container?.scrollLeft ?? 0;
				sourceTime =
					oldPps > 0
						? (scrollLeft + anchorScreen) / oldPps
						: (pending?.sourceTime ?? 0);
			}
			const intent = viewportIntentRef.current + 1;
			viewportIntentRef.current = intent;
			pendingAnchorRef.current = { sourceTime, screenX: anchorScreen, intent };
			preferenceRef.current = next;
			setViewportPreference(next);
			requestAnimationFrame(() => {
				if (viewportIntentRef.current !== intent) return;
				const node = scrollContainerRef.current;
				applyPendingAnchor(
					node && node.clientWidth > 0
						? node.clientWidth
						: timelineViewportWidth,
					preferenceRef.current,
				);
			});
		},
		[applyPendingAnchor, timelineViewportWidth],
	);

	const measuredViewportWidth = useCallback(() => {
		const live = scrollContainerRef.current?.clientWidth ?? 0;
		if (Number.isFinite(live) && live > 0) return live;
		return timelineViewportWidth > 0 ? timelineViewportWidth : 0;
	}, [timelineViewportWidth]);

	const stepViewportDensity = useCallback(
		(factor: number, anchorClientX?: number) => {
			applyViewportPreference(
				stepEditingDensity(
					preferenceRef.current,
					factor,
					measuredViewportWidth(),
					stateRef.current.duration,
				),
				anchorClientX,
			);
		},
		[applyViewportPreference, measuredViewportWidth],
	);

	useLayoutEffect(() => {
		applyPendingAnchor(timelineViewportWidth, viewportPreference);
	}, [applyPendingAnchor, timelineViewportWidth, viewportPreference]);

	const handleTimelinePointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (event.button !== 0) return;
			const target = event.target as HTMLElement;
			if (target.closest("[data-trim-handle]")) return;

			const timeline = timelineRef.current;
			if (!timeline) return;
			const rect = timeline.getBoundingClientRect();
			if (rect.width <= 0) return;

			const computeTime = (clientX: number) =>
				getTimelineSourceTimeFromClientX(clientX, rect, stateRef.current);

			const time = computeTime(event.clientX);

			seekTo(time, true);
			let lastTime = time;

			const handleMove = (moveEvent: PointerEvent) => {
				lastTime = computeTime(moveEvent.clientX);
				seekTo(lastTime);
			};
			const handleUp = (upEvent: PointerEvent) => {
				window.removeEventListener("pointermove", handleMove);
				window.removeEventListener("pointerup", handleUp);
				lastTime = computeTime(upEvent.clientX);
				seekTo(lastTime, true);
			};
			window.addEventListener("pointermove", handleMove);
			window.addEventListener("pointerup", handleUp, { once: true });
		},
		[seekTo],
	);

	useEffect(() => {
		if (isSaving || !activePlaybackSrc) return;
		let frameId = 0;
		let playbackFrameId = 0;
		let detachVideoListeners: (() => void) | null = null;

		const attachVideoListeners = () => {
			const videoElement = videoRef.current;
			if (!videoElement) {
				frameId = requestAnimationFrame(attachVideoListeners);
				return;
			}

			let restoreAudioAfterCut = false;
			const muteForCut = () => {
				if (restoreAudioAfterCut || videoElement.muted) return;
				restoreAudioAfterCut = true;
				videoElement.muted = true;
			};
			const restoreCutAudio = () => {
				if (!restoreAudioAfterCut) return;
				restoreAudioAfterCut = false;
				videoElement.muted = false;
			};
			const syncPlayhead = (updatePlayhead: boolean) => {
				if (previewWithoutPlayheadRef.current) {
					// Trimming a clip edge: scrub the preview but keep the cursor put.
					return;
				}
				if (dragDraftRef.current !== null) {
					if (updatePlayhead) {
						setPlayheadOnFrame(videoElement.currentTime, true);
					}
					return;
				}
				const currentTime = videoElement.currentTime;
				const playableRangeIndex = findPlayableRangeIndex(
					currentTime,
					keepRanges,
				);
				const playableRange = keepRanges[playableRangeIndex];
				if (
					!videoElement.paused &&
					playableRange &&
					playableRangeIndex < keepRanges.length - 1 &&
					playableRange.end - currentTime <= PREVIEW_CUT_MUTE_LEAD_SECONDS
				) {
					muteForCut();
				}
				const nextTime =
					playableRangeIndex >= 0
						? currentTime
						: findNextPlayableTimeInRanges(currentTime, keepRanges);

				if (nextTime === null) {
					videoElement.pause();
					videoElement.currentTime = keepRanges[0]?.start ?? 0;
					setPlayheadOnFrame(videoElement.currentTime, true);
					return;
				}

				if (Math.abs(nextTime - currentTime) > 0.04) {
					muteForCut();
					videoElement.currentTime = nextTime;
					setPlayheadOnFrame(nextTime, true);
					return;
				}

				if (updatePlayhead) {
					setPlayheadOnFrame(currentTime, true);
				}
			};
			const handleMediaTimeChange = () => syncPlayhead(true);

			const stopPlaybackFrames = () => {
				cancelAnimationFrame(playbackFrameId);
				playbackFrameId = 0;
			};
			const followPlayback = () => {
				playbackFrameId = 0;
				syncPlayhead(false);
				if (!videoElement.paused && !videoElement.ended) {
					playbackFrameId = requestAnimationFrame(followPlayback);
				}
			};
			const handlePlay = () => {
				followSuspendedRef.current = false;
				setIsPlaying(true);
				stopPlaybackFrames();
				playbackFrameId = requestAnimationFrame(followPlayback);
			};
			const handlePause = () => {
				stopPlaybackFrames();
				setIsPlaying(false);
				if (!videoElement.seeking) {
					restoreCutAudio();
				}
				syncPlayhead(true);
			};
			const handleSeeked = () => {
				restoreCutAudio();
				syncPlayhead(true);
			};

			videoElement.addEventListener("timeupdate", handleMediaTimeChange);
			videoElement.addEventListener("seeking", handleMediaTimeChange);
			videoElement.addEventListener("seeked", handleSeeked);
			videoElement.addEventListener("loadedmetadata", handleMediaTimeChange);
			videoElement.addEventListener("play", handlePlay);
			videoElement.addEventListener("pause", handlePause);
			syncPlayhead(true);
			if (videoElement.paused) {
				setIsPlaying(false);
			} else {
				handlePlay();
			}

			detachVideoListeners = () => {
				stopPlaybackFrames();
				videoElement.removeEventListener("timeupdate", handleMediaTimeChange);
				videoElement.removeEventListener("seeking", handleMediaTimeChange);
				videoElement.removeEventListener("seeked", handleSeeked);
				videoElement.removeEventListener(
					"loadedmetadata",
					handleMediaTimeChange,
				);
				videoElement.removeEventListener("play", handlePlay);
				videoElement.removeEventListener("pause", handlePause);
				restoreCutAudio();
			};
		};

		attachVideoListeners();

		return () => {
			cancelAnimationFrame(frameId);
			detachVideoListeners?.();
		};
	}, [activePlaybackSrc, isSaving, keepRanges, setPlayheadOnFrame]);

	useEffect(() => {
		if (isSaving) return;
		const videoElement = videoRef.current;
		if (!videoElement) return;
		const nextTime = findNextPlayableTime(videoElement.currentTime, editSpec);
		if (
			nextTime !== null &&
			Math.abs(nextTime - videoElement.currentTime) > 0.04
		) {
			videoElement.currentTime = nextTime;
		}
	}, [editSpec, isSaving]);

	useEffect(() => {
		if (isSaving || isTrimming) return;
		if (isPlaying && followSuspendedRef.current) return;
		if (zoomRef.current <= 1) return;
		const container = scrollContainerRef.current;
		if (!container) return;
		const playheadFraction =
			state.duration > 0 ? clampedPlayhead / state.duration : 0;
		const playheadX = playheadFraction * container.scrollWidth;
		const visibleStart = container.scrollLeft;
		const visibleEnd = visibleStart + container.clientWidth;
		const padding = 32;
		if (
			playheadX < visibleStart + padding ||
			playheadX > visibleEnd - padding
		) {
			writeTimelineScroll(
				container,
				Math.max(0, playheadX - container.clientWidth / 2),
			);
		}
	}, [
		clampedPlayhead,
		isSaving,
		isPlaying,
		isTrimming,
		state.duration,
		writeTimelineScroll,
	]);

	useEffect(() => {
		if (isSaving) return;
		const container = scrollContainerRef.current;
		if (!container) return;
		const handleWheel = (event: WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			const direction = event.deltaY > 0 ? -1 : 1;
			const factor =
				1 + direction * Math.min(Math.abs(event.deltaY) / 120, 1) * 0.25;
			stepViewportDensity(factor, event.clientX);
		};
		container.addEventListener("wheel", handleWheel, { passive: false });
		return () => container.removeEventListener("wheel", handleWheel);
	}, [isSaving, stepViewportDensity]);

	useEffect(() => {
		if (isSaving) return;
		updatePlayheadOverlay();
		const container = scrollContainerRef.current;
		if (!container) return;
		let frameId = 0;
		const onScroll = () => {
			cancelAnimationFrame(frameId);
			frameId = requestAnimationFrame(updatePlayheadOverlay);
		};
		container.addEventListener("scroll", onScroll, { passive: true });
		const resizeObserver = new ResizeObserver(onScroll);
		resizeObserver.observe(container);
		return () => {
			cancelAnimationFrame(frameId);
			container.removeEventListener("scroll", onScroll);
			resizeObserver.disconnect();
		};
	}, [isSaving, updatePlayheadOverlay]);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (isSaving) return;
			if (isEditorShortcutTarget(event.target, event.defaultPrevented)) return;
			const isMeta = event.metaKey || event.ctrlKey;

			if (event.key === " ") {
				event.preventDefault();
				togglePlayPause();
				return;
			}

			if (event.key === "Backspace" || event.key === "Delete") {
				event.preventDefault();
				handleBackspace();
				return;
			}

			if (event.key.toLowerCase() === "s" && !isMeta) {
				event.preventDefault();
				if (!event.repeat) handleSplit();
				return;
			}

			if (event.key === "ArrowLeft") {
				event.preventDefault();
				const step = event.shiftKey ? 1 : 0.1;
				seekTo(playhead - step, true, "backward");
				return;
			}

			if (event.key === "ArrowRight") {
				event.preventDefault();
				const step = event.shiftKey ? 1 : 0.1;
				seekTo(playhead + step, true);
				return;
			}

			if (isMeta && event.key.toLowerCase() === "z") {
				event.preventDefault();
				if (event.shiftKey) {
					handleRedo();
				} else {
					handleUndo();
				}
				return;
			}

			if (event.key === "+" || event.key === "=") {
				event.preventDefault();
				stepViewportDensity(ZOOM_DENSITY_FACTOR);
				return;
			}

			if (event.key === "-" || event.key === "_") {
				event.preventDefault();
				stepViewportDensity(1 / ZOOM_DENSITY_FACTOR);
				return;
			}

			if (event.key === "0") {
				event.preventDefault();
				applyViewportPreference({ kind: "fit" });
				return;
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [
		handleBackspace,
		handleRedo,
		handleSplit,
		handleUndo,
		isSaving,
		playhead,
		seekTo,
		togglePlayPause,
		applyViewportPreference,
		stepViewportDensity,
	]);

	// Unmount the timeline before publish resolves. Reconciling this tree on
	// setIsSaving hides the already-arrived response on WebKit (cap-fzp.8.7.10).
	if (isSaving) {
		return (
			<div
				data-editor-shell="publishing"
				className="flex min-h-screen items-center justify-center bg-gray-1 text-gray-12"
			>
				<output>
					{waitingForRelocation
						? "Waiting for source privacy checks… (up to 60 seconds)"
						: "Saving / Publishing"}
				</output>
			</div>
		);
	}

	return (
		<div
			data-editor-shell="editor"
			className="flex h-svh min-h-0 flex-col overflow-hidden bg-gray-1 text-gray-12"
			style={{
				["--editor-dock-height" as string]:
					dockHeightPx > 0 ? `${dockHeightPx}px` : "16rem",
			}}
		>
			<header className="sticky top-0 z-30 shrink-0 border-b border-gray-4 bg-white/85 backdrop-blur">
				<div className="mx-auto flex h-14 w-full max-w-[1500px] items-center justify-between gap-2 px-3 sm:h-16 sm:px-5">
					<div className="flex items-center gap-1.5">
						<button
							type="button"
							onClick={handleCancel}
							className="inline-flex h-9 items-center rounded-full bg-gray-3 px-4 text-[14px] font-medium text-gray-12 shadow-[inset_0_1px_0_rgba(255,255,255,0.6),inset_0_-1px_0_rgba(0,0,0,0.02)] ring-1 ring-gray-5 transition hover:bg-gray-4 active:bg-gray-5"
						>
							Cancel
						</button>
						<button
							type="button"
							aria-label="Restore original"
							title="Restore original"
							disabled={
								!canRestore ||
								isSaving ||
								isRestoring ||
								restoreRoute(instantFinish) === "wait"
							}
							onClick={() => setShowRestoreConfirm(true)}
							className="inline-flex h-9 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium text-gray-11 transition hover:bg-gray-3 hover:text-gray-12 active:bg-gray-4 disabled:pointer-events-none disabled:opacity-30 sm:px-3"
						>
							<RotateCcw className="size-4" aria-hidden />
							<span className="hidden sm:inline">Restore</span>
						</button>
						<VideoDownloadMenu
							videoId={video.id}
							hasEdits={hasExistingEdits}
							align="start"
						/>
					</div>
					<div className="min-w-0 flex-1 px-2 text-center">
						<h1 className="truncate text-[15px] font-semibold text-gray-12">
							{video.name}
						</h1>
					</div>
					<div className="flex items-center gap-1">
						<HeaderIconButton
							label="Undo"
							disabled={!canUndo}
							onClick={handleUndo}
						>
							<Undo2 className="size-[18px]" />
						</HeaderIconButton>
						<HeaderIconButton
							label="Redo"
							disabled={!canRedo}
							onClick={handleRedo}
						>
							<Redo2 className="size-[18px]" />
						</HeaderIconButton>
						<Button
							variant="blue"
							size="sm"
							spinner={isSaving}
							disabled={
								isSaving ||
								isRestoring ||
								keepRanges.length === 0 ||
								doneRoute(instantFinish) === "wait"
							}
							onPointerDown={prepareOnPointerDown}
							onClick={handleDone}
							className="ml-1"
						>
							Done
						</Button>
					</div>
				</div>
			</header>

			<div
				data-editor-stage=""
				className="flex min-h-0 flex-1 flex-col overflow-hidden"
			>
				<main
					className={[
						"mx-auto flex min-h-0 w-full flex-1 flex-col px-3 pt-3 pb-4 sm:px-5 sm:pt-4 sm:pb-5",
						editReadiness.readiness?.transcriptUsable
							? "max-w-[1500px] xl:pr-[640px]"
							: "max-w-6xl",
					].join(" ")}
				>
					{!editReadiness.readiness?.transcriptUsable && (
						<section className="mb-3 rounded-xl border border-gray-4 p-3">
							<EditReadinessStatus state={editReadiness} />
							{editReadiness.readiness?.transcriptLabel ===
								"Word timings unavailable" && (
								<button
									type="button"
									disabled={isPreparingTranscript}
									className="mt-2 text-sm underline disabled:opacity-50"
									onClick={async () => {
										setIsPreparingTranscript(true);
										try {
											const result = await requestEditTranscript(video.id);
											if (result.status === "error")
												toast.error(
													"Word timings could not be prepared. Use the share page recovery controls.",
												);
											editReadiness.checkAgain();
										} catch {
											toast.error(
												"Word timings could not be prepared. Check again.",
											);
										} finally {
											setIsPreparingTranscript(false);
										}
									}}
								>
									Prepare word timings
								</button>
							)}
							<p className="mt-2 text-sm text-gray-11">
								Manual timeline editing remains available. Word editing and
								auto-cuts require usable word timings. For transcription
								recovery or settings, use the share page controls.
							</p>
						</section>
					)}
					<section className="flex min-h-0 flex-1 items-center justify-center">
						<div
							className="relative max-h-full max-w-full overflow-hidden rounded-xl bg-black ring-1 ring-gray-5 [&_[data-slot=media-player-controls]]:!hidden"
							style={{
								aspectRatio:
									video.width && video.height
										? `${video.width} / ${video.height}`
										: "16 / 9",
								width:
									video.width && video.height
										? `min(100%, calc((100svh - var(--editor-dock-height, 16rem) - 6.5rem) * ${video.width} / ${video.height}))`
										: "100%",
								viewTransitionName: "cap-edit-video",
								boxShadow: [
									"0 1px 2px rgba(15,23,42,0.05)",
									"0 4px 12px -2px rgba(15,23,42,0.08)",
									"0 24px 48px -12px rgba(15,23,42,0.10)",
								].join(", "),
							}}
						>
							<CapVideoPlayer
								videoSrc={activePlaybackSrc}
								videoId={video.id}
								chaptersSrc={chaptersUrl ?? ""}
								captionsSrc=""
								disableCaptions
								videoRef={videoRef}
								mediaPlayerClassName="h-full w-full"
								enableCrossOrigin
								hasActiveUpload={false}
								disableCommentStamps
								disableReactionStamps
								disablePreviewGif
								disablePlaybackSpeedDial
								duration={state.duration}
								showFloatingVolumeControl
							/>
						</div>
					</section>
				</main>

				{editReadiness.readiness?.transcriptUsable && (
					<TranscriptSidebar
						videoId={video.id}
						videoRef={videoRef}
						keepRanges={keepRanges}
						autoCuts={editSpec.autoCuts}
						autoCutsInitialized={editSpec.autoCutsInitialized}
						onDeleteRanges={handleTranscriptDelete}
						onRestoreRanges={handleTranscriptRestore}
						onSetAutoCutLayer={handleSetAutoCutLayer}
						onInitializeAutoCuts={handleInitializeAutoCuts}
					/>
				)}
			</div>

			<section
				ref={dockRef}
				data-editor-dock=""
				className="shrink-0 border-t border-gray-4 bg-gray-1 px-3 pt-3.5 pb-4 sm:px-5"
			>
				<EditorWaveformToolbar
					hidden={hideWaveform}
					onToggle={() => setHideWaveform((current) => !current)}
					zoom={zoom}
					minZoom={1}
					maxZoom={100}
					sliderValue={sliderStop}
					onZoom={(stop) =>
						applyViewportPreference(
							preferenceFromSliderStop(
								stop,
								measuredViewportWidth(),
								stateRef.current.duration,
							),
						)
					}
					onZoomIn={() => stepViewportDensity(ZOOM_DENSITY_FACTOR)}
					onZoomOut={() => stepViewportDensity(1 / ZOOM_DENSITY_FACTOR)}
					onWholeVideo={() => applyViewportPreference({ kind: "fit" })}
					zoomLabel={zoomLabel}
					zoomInDisabled={zoomInDisabled}
				/>

				<div className="relative mt-2 flex items-center gap-2.5 sm:gap-3">
					<button
						type="button"
						aria-label={isPlaying ? "Pause" : "Play"}
						onClick={togglePlayPause}
						style={{
							boxShadow: [
								"inset 0 1px 0 rgba(255,255,255,0.16)",
								"0 1px 2px rgba(15,23,42,0.10)",
								"0 8px 20px -4px rgba(15,23,42,0.25)",
								"0 16px 32px -10px rgba(15,23,42,0.20)",
							].join(", "),
						}}
						className="flex h-16 w-14 shrink-0 items-center justify-center rounded-lg bg-gray-12 text-white ring-1 ring-gray-12 transition hover:bg-gray-11 active:bg-gray-10 sm:w-16"
					>
						{isPlaying ? (
							<Pause className="size-5" strokeWidth={2.5} aria-hidden />
						) : (
							<Play
								className="size-5 translate-x-0.5"
								strokeWidth={2.5}
								aria-hidden
							/>
						)}
					</button>

					<div className="relative flex-1">
						<div
							ref={scrollContainerRef}
							className={[
								"relative w-full overflow-x-auto overflow-y-hidden rounded-lg bg-white ring-1 ring-gray-5",
								"[&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/20 [&::-webkit-scrollbar-track]:bg-transparent",
								"overscroll-x-contain",
							].join(" ")}
							style={{
								scrollbarColor: "rgba(0,0,0,0.2) transparent",
								boxShadow: [
									"0 1px 2px rgba(15,23,42,0.05)",
									"0 4px 12px -2px rgba(15,23,42,0.08)",
									"0 16px 32px -12px rgba(15,23,42,0.10)",
								].join(", "),
							}}
						>
							<div
								ref={timelineRef}
								data-editor-timeline=""
								data-zoom-mode={viewportPreference.kind}
								data-pixels-per-second={formatZoomMeasure(editingPxPerSec)}
								data-visible-seconds={formatZoomMeasure(
									editingPxPerSec > 0 && timelineViewportWidth > 0
										? timelineViewportWidth / editingPxPerSec
										: state.duration,
								)}
								onPointerDown={handleTimelinePointerDown}
								onPointerMove={(event) => {
									const rect = event.currentTarget.getBoundingClientRect();
									if (rect.width <= 0) return;
									setHoverFraction(
										Math.min(
											1,
											Math.max(0, (event.clientX - rect.left) / rect.width),
										),
									);
								}}
								onPointerLeave={() => setHoverFraction(null)}
								className="group relative cursor-pointer select-none"
								style={{
									width: timelineTrackWidth,
									minWidth: "100%",
								}}
							>
								<EditorTimelineRuler
									duration={state.duration}
									scrollLeft={timelineScrollLeft}
									viewportWidth={timelineViewportWidth}
									zoom={zoom}
								/>
								<EditorChapterLane
									chapters={playbackChapters}
									duration={state.duration}
								/>
								<div
									data-waveform-lane=""
									className="relative h-16 overflow-hidden"
								>
									<div
										className={
											hideWaveform ? "absolute inset-0 flex" : "hidden"
										}
									>
										{thumbnailSlots.map((slot) => (
											<div
												key={slot.key}
												className="relative min-w-0 flex-1 overflow-hidden border-r border-white/[0.04] bg-gray-12 last:border-r-0"
											>
												{slot.src ? (
													<div
														className="absolute inset-0 bg-cover bg-center opacity-95"
														style={{
															backgroundImage: `url(${JSON.stringify(slot.src)})`,
														}}
													/>
												) : (
													<div className="absolute inset-0 bg-gradient-to-br from-gray-11 to-gray-12" />
												)}
											</div>
										))}
									</div>

									{segments
										.filter((segment) => segment.deleted)
										.map((segment) => {
											const startPct = getTimePercent(
												segment.start,
												state.duration,
											);
											const endPct = getTimePercent(
												segment.end,
												state.duration,
											);
											return (
												<div
													key={`deleted-${segment.id}`}
													data-timeline-deleted=""
													data-removed-marker=""
													role="img"
													aria-label={`Removed section ${formatTime(segment.start)}–${formatTime(segment.end)}`}
													className="pointer-events-none absolute inset-y-0 z-[4]"
													style={{
														left: `${startPct}%`,
														width: `${Math.max(0, endPct - startPct)}%`,
													}}
												></div>
											);
										})}

									<EditorChapterMarkers
										chapters={playbackChapters}
										outputDuration={state.duration}
									/>

									<div
										className="pointer-events-none absolute inset-y-0 left-0 bg-white/75"
										style={{
											width: `${trimStartPct}%`,
										}}
									/>
									<div
										className="pointer-events-none absolute inset-y-0 right-0 bg-white/75"
										style={{
											width: `${100 - trimEndPct}%`,
										}}
									/>

									{capsuleOutlineGroups(visibleSegments, editingPxPerSec).map(
										(group) => {
											const startPct = getTimePercent(
												group.start,
												state.duration,
											);
											const endPct = getTimePercent(group.end, state.duration);
											return (
												<div
													key={`outline-${group.start}`}
													data-capsule-outline=""
													className="pointer-events-none absolute inset-y-1 z-[5] rounded-xl border-[1.5px] border-[#9c95ee]"
													style={{
														left: `calc(${startPct}% + 1.5px)`,
														width: `calc(${Math.max(0, endPct - startPct)}% - 3px)`,
													}}
												/>
											);
										},
									)}

									{visibleSegments.map((clip, index) => {
										const isFirst = index === 0;
										const isLast = index === visibleSegments.length - 1;
										const hasMultipleClips = visibleSegments.length > 1;
										const isActive = activeSegmentAtPlayhead?.id === clip.id;
										const startPct = getTimePercent(clip.start, state.duration);
										const endPct = getTimePercent(clip.end, state.duration);
										const widthPct = Math.max(0, endPct - startPct);
										return (
											<Fragment key={`clip-${clip.id}`}>
												<div
													data-clip-capsule=""
													data-selected={
														isActive || !hasMultipleClips ? "" : undefined
													}
													className={[
														"pointer-events-none absolute inset-y-1 z-[5] overflow-hidden rounded-xl transition-colors",
														isActive && hasMultipleClips
															? "border-2 border-[#2a1f9e] bg-[#5b4ee6]/25"
															: "",
													].join(" ")}
													style={{
														left: `calc(${startPct}% + 1.5px)`,
														width: `calc(${widthPct}% - 3px)`,
													}}
												></div>

												<button
													type="button"
													aria-label={
														isFirst ? "Trim start" : "Trim clip start"
													}
													data-trim-handle
													data-handle-visible={
														!hasMultipleClips || isActive ? "" : undefined
													}
													onPointerDown={(event) =>
														startClipEdgeDrag(clip.id, "start", isFirst, event)
													}
													className={[
														"absolute inset-y-1 z-20 flex w-3.5 cursor-ew-resize touch-none items-center justify-center rounded-md bg-blue-500 text-white transition hover:bg-blue-400 active:bg-blue-600",
														!hasMultipleClips || isActive ? "" : "invisible",
														isFirst
															? "w-6 rounded-l-lg shadow-[0_1px_2px_rgba(0,0,0,0.3),0_2px_8px_-1px_rgba(59,130,246,0.55)]"
															: "rounded-l-md shadow-[0_1px_2px_rgba(0,0,0,0.35)]",
														activeHandle === "start" && isFirst
															? "ring-2 ring-blue-300 ring-inset"
															: "",
													].join(" ")}
													style={
														isFirst
															? { left: `${startPct}%` }
															: {
																	left: `${startPct}%`,
																	width: `min(0.75rem, ${(widthPct / 3).toFixed(3)}%)`,
																}
													}
												>
													{isFirst ? (
														<ChevronLeft
															className="size-5"
															strokeWidth={3}
															aria-hidden
														/>
													) : (
														<span
															className="h-5 w-0.5 rounded-full bg-white/85"
															aria-hidden
														/>
													)}
												</button>

												<button
													type="button"
													aria-label={isLast ? "Trim end" : "Trim clip end"}
													data-trim-handle
													data-handle-visible={
														!hasMultipleClips || isActive ? "" : undefined
													}
													onPointerDown={(event) =>
														startClipEdgeDrag(clip.id, "end", isLast, event)
													}
													className={[
														"absolute inset-y-1 z-20 flex w-3.5 -translate-x-full cursor-ew-resize touch-none items-center justify-center rounded-md bg-blue-500 text-white transition hover:bg-blue-400 active:bg-blue-600",
														!hasMultipleClips || isActive ? "" : "invisible",
														isLast
															? "w-6 rounded-r-lg shadow-[0_1px_2px_rgba(0,0,0,0.3),0_2px_8px_-1px_rgba(59,130,246,0.55)]"
															: "rounded-r-md shadow-[0_1px_2px_rgba(0,0,0,0.35)]",
														activeHandle === "end" && isLast
															? "ring-2 ring-blue-300 ring-inset"
															: "",
													].join(" ")}
													style={
														isLast
															? { left: `${endPct}%` }
															: {
																	left: `${endPct}%`,
																	width: `min(0.75rem, ${(widthPct / 3).toFixed(3)}%)`,
																}
													}
												>
													{isLast ? (
														<ChevronRight
															className="size-5"
															strokeWidth={3}
															aria-hidden
														/>
													) : (
														<span
															className="h-5 w-0.5 rounded-full bg-white/85"
															aria-hidden
														/>
													)}
												</button>
											</Fragment>
										);
									})}

									{timelineDisplaySplitPoints.map((splitPoint, index) => {
										if (!splitPoint.removable) return null;
										const positionPercent = getTimePercent(
											splitPoint.sourceTime,
											state.duration,
										);
										return (
											<button
												key={`merge-${splitPoint.id}`}
												type="button"
												aria-label="Remove cut"
												title="Remove cut"
												data-trim-handle
												onPointerDown={(event) => event.stopPropagation()}
												onClick={(event) => {
													event.stopPropagation();
													removeSplitAtIndex(index);
												}}
												className="absolute -top-9 left-0 z-[50] flex size-4 -translate-x-1/2 items-center justify-center rounded-full bg-gray-12 text-white opacity-0 shadow-[0_2px_6px_rgba(0,0,0,0.45)] ring-1 ring-black/30 transition-all hover:scale-110 hover:!opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 group-hover:opacity-80 [@media(hover:none)]:opacity-70"
												style={{ left: `${positionPercent}%` }}
											>
												<X className="size-2.5" strokeWidth={3} aria-hidden />
											</button>
										);
									})}
									<EditorWaveformCanvas
										pairs={waveformPairs}
										noAudio={waveformNoAudio}
										duration={state.duration}
										deleted={segments
											.filter((segment) => segment.deleted)
											.map((segment) => ({
												start: segment.start,
												end: segment.end,
											}))}
										hidden={hideWaveform}
										scrollLeft={timelineScrollLeft}
										viewportWidth={timelineViewportWidth}
										zoom={zoom}
									/>
								</div>
								<EditorHoverGhost fraction={hoverFraction} />
							</div>
						</div>

						<EditorPlayhead
							ref={playheadOverlayRef}
							label={formatTimeDetailed(outputPlayhead)}
						/>
					</div>
				</div>

				<div className="mt-4 flex items-center justify-between gap-3 px-1 sm:mt-5">
					<button
						type="button"
						title="Split at the playhead (S)"
						onClick={handleSplit}
						className="inline-flex h-9 select-none items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium text-gray-12 transition hover:bg-gray-3 active:bg-gray-4"
					>
						<Scissors className="size-3.5" aria-hidden />
						<span>Split</span>
					</button>

					<div className="flex items-center gap-3">
						<div className="inline-flex items-baseline gap-1.5 font-mono text-[12px] tabular-nums">
							<span className="font-semibold text-gray-12">
								{formatTime(outputPlayhead)}
							</span>
							<span className="text-gray-9">/</span>
							<span
								className={
									outputDuration < state.duration - 0.05
										? "font-semibold text-blue-600"
										: "text-gray-10"
								}
							>
								<span className="font-sans text-[9px] font-medium">
									{hasOutputEdits ? "Edited" : "Original"}
								</span>{" "}
								{formatTime(outputDuration)}
							</span>
						</div>
					</div>

					<ToolButton
						tone="danger"
						disabled={!canDeleteSegment}
						onClick={handleDelete}
						icon={<Trash2 className="size-3.5" aria-hidden />}
						label="Delete"
					/>
				</div>
			</section>

			<Dialog
				open={showRestoreConfirm}
				onOpenChange={(open) => {
					if (isRestoring) return;
					setShowRestoreConfirm(open);
				}}
			>
				<DialogContent className="max-w-sm p-0">
					<DialogHeader icon={<RotateCcw className="size-5" />}>
						<DialogTitle>Restore original video?</DialogTitle>
					</DialogHeader>
					<DialogDescription>
						This discards your current edits and restores the video to its
						original recording. This can't be undone.
					</DialogDescription>
					<DialogFooter>
						<Button
							variant="gray"
							size="sm"
							disabled={isRestoring}
							onClick={() => setShowRestoreConfirm(false)}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							size="sm"
							spinner={isRestoring}
							disabled={isRestoring}
							onClick={handleRestore}
						>
							{isRestoring ? "Restoring" : "Restore original"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

"use client";

import { forwardRef, useEffect, useRef } from "react";
import {
	PEAKS_PAIRS_PER_SEC,
	type PeakPair,
	waveformColumns,
} from "@/lib/waveform-peaks";

export const WAVEFORM_RETRY_DELAYS_MS = [8_000, 30_000] as const;

export function nextWaveformRetryMs(failure: number): number | null {
	return WAVEFORM_RETRY_DELAYS_MS[failure] ?? null;
}

export function chapterLaneLayout(input: {
	chapters: readonly { title: string; start: number }[];
	duration: number;
}) {
	if (input.duration <= 0) return [];
	return input.chapters.map((chapter, index) => {
		const next = input.chapters[index + 1];
		const left = (chapter.start / input.duration) * 100;
		const right = next ? (next.start / input.duration) * 100 : 100;
		return {
			title: chapter.title,
			start: chapter.start,
			left,
			maxWidth: Math.max(0, right - left),
		};
	});
}

export function EditorWaveformToolbar({
	hidden,
	onToggle,
	zoom,
	minZoom,
	maxZoom,
	onZoom,
	onWholeVideo,
	sliderValue,
	sliderStops = ZOOM_SLIDER_INCREMENTS,
	onZoomIn,
	onZoomOut,
	zoomLabel,
	zoomInDisabled = false,
}: {
	hidden: boolean;
	onToggle: () => void;
	zoom: number;
	minZoom: number;
	maxZoom: number;
	onZoom: (zoom: number) => void;
	onWholeVideo: () => void;
	sliderValue?: number;
	sliderStops?: number;
	onZoomIn?: () => void;
	onZoomOut?: () => void;
	zoomLabel?: string;
	zoomInDisabled?: boolean;
}) {
	const usingStops = sliderValue !== undefined;
	const atMinimum = usingStops ? sliderValue <= 0 : zoom <= minZoom + 0.01;
	const atMaximum = usingStops
		? zoomInDisabled || sliderValue >= sliderStops
		: zoom >= maxZoom - 0.01;
	return (
		<div data-waveform-toolbar="" className="mb-2.5 flex items-center gap-1.5">
			<button
				type="button"
				data-hide-waveform=""
				aria-pressed={!hidden}
				onClick={onToggle}
				className="inline-flex h-8 items-center rounded-lg px-3 text-[13px] font-medium text-gray-12 hover:bg-gray-3 aria-pressed:bg-blue-3 aria-pressed:text-blue-11"
			>
				{hidden ? "Show waveform" : "Hide waveform"}
			</button>
			<div className="flex-1" />
			<fieldset
				className="inline-flex items-center gap-0.5 border-0 p-0"
				aria-label="Zoom"
			>
				<button
					type="button"
					aria-label="Zoom out"
					title="Zoom out (−)"
					data-zoom-out=""
					disabled={atMinimum}
					onClick={() =>
						onZoomOut ? onZoomOut() : onZoom(zoom / ZOOM_DENSITY_FACTOR)
					}
					className="inline-flex size-8 items-center justify-center rounded-lg text-gray-11 hover:bg-gray-3 disabled:opacity-30"
				>
					−
				</button>
				<input
					type="range"
					aria-label="Zoom level"
					aria-valuetext={zoomLabel}
					data-zoom-level=""
					min={usingStops ? 0 : minZoom}
					max={usingStops ? sliderStops : maxZoom}
					step={usingStops ? 1 : 0.1}
					value={usingStops ? sliderValue : zoom}
					onChange={(event) => onZoom(Number.parseFloat(event.target.value))}
					className="h-1 w-28 cursor-pointer accent-gray-12"
				/>
				{zoomLabel ? (
					<span
						data-zoom-readout=""
						className="min-w-14 text-right font-mono text-[11px] tabular-nums text-gray-11"
					>
						{zoomLabel}
					</span>
				) : null}
				<button
					type="button"
					aria-label="Zoom in"
					title="Zoom in (+)"
					data-zoom-in=""
					disabled={atMaximum}
					onClick={() =>
						onZoomIn ? onZoomIn() : onZoom(zoom * ZOOM_DENSITY_FACTOR)
					}
					className="inline-flex size-8 items-center justify-center rounded-lg text-gray-11 hover:bg-gray-3 disabled:opacity-30"
				>
					+
				</button>
			</fieldset>
			<button
				type="button"
				data-whole-video=""
				title="Show whole video (0)"
				onClick={onWholeVideo}
				className="inline-flex h-8 items-center rounded-lg px-3 text-[13px] font-medium text-gray-12 hover:bg-gray-3"
			>
				Whole video
			</button>
		</div>
	);
}

export function EditorChapterLane({
	chapters,
	duration,
}: {
	chapters: readonly { title: string; start: number }[];
	duration: number;
}) {
	const laid = chapterLaneLayout({ chapters, duration });
	return (
		<div data-chapter-lane="" className="relative h-[18px]">
			{laid.map((chapter) => (
				<div
					key={`${chapter.start}-${chapter.title}`}
					data-chapter-title=""
					data-source-start={chapter.start}
					className="absolute top-0 h-full overflow-hidden border-l border-gray-7 pl-1 text-[10px] font-medium text-gray-11"
					style={{
						left: `${chapter.left}%`,
						maxWidth: `${chapter.maxWidth}%`,
					}}
				>
					<span className="block truncate">{chapter.title}</span>
				</div>
			))}
		</div>
	);
}

const RULER_STEPS = [
	0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600,
];
export const TIMELINE_RULER_PX = 22;
export const TIMELINE_CHAPTER_PX = 18;
export const TIMELINE_WAVEFORM_PX = 64;
export const WAVEFORM_PITCH_PX = 3;
export const WAVEFORM_BAR_PX = 2;
export const WAVEFORM_GAMMA = 3;
export const PLAYHEAD_LINE_TOP_PX = TIMELINE_RULER_PX + TIMELINE_CHAPTER_PX;

export function visibleSourceWindow(input: {
	sourceDuration: number;
	scrollLeft: number;
	viewportWidth: number;
	zoom: number;
}): { start: number; end: number } {
	const duration =
		Number.isFinite(input.sourceDuration) && input.sourceDuration > 0
			? input.sourceDuration
			: 0;
	const zoom = Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1;
	const viewport = Math.max(1, input.viewportWidth);
	const timeline = viewport * zoom;
	const left = Math.min(timeline, Math.max(0, input.scrollLeft));
	const right = Math.min(timeline, left + viewport);
	return {
		start: duration === 0 ? 0 : (left / timeline) * duration,
		end: duration === 0 ? 0 : (right / timeline) * duration,
	};
}

export const EDIT_DENSITY_CAP_PX_PER_SEC = 400;
export const ZOOM_DENSITY_FACTOR = 1.25;
export const ZOOM_SLIDER_INCREMENTS = 100;

export type ViewportPreference =
	| { kind: "fit" }
	| { kind: "density"; pixelsPerSecond: number };

export function fitFloorPxPerSec(
	viewportWidth: number,
	sourceDuration: number,
): number {
	if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 0;
	if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) return 0;
	return viewportWidth / sourceDuration;
}

export function effectiveMaxPxPerSec(
	viewportWidth: number,
	sourceDuration: number,
): number {
	const floor = fitFloorPxPerSec(viewportWidth, sourceDuration);
	if (!(floor > 0)) return EDIT_DENSITY_CAP_PX_PER_SEC;
	return Math.max(floor, EDIT_DENSITY_CAP_PX_PER_SEC);
}

export function clampEditingDensity(
	pixelsPerSecond: number,
	viewportWidth: number,
	sourceDuration: number,
): number {
	const floor = fitFloorPxPerSec(viewportWidth, sourceDuration);
	const max = effectiveMaxPxPerSec(viewportWidth, sourceDuration);
	if (!(floor > 0) || !Number.isFinite(pixelsPerSecond)) return floor;
	return Math.min(max, Math.max(floor, pixelsPerSecond));
}

export function effectivePxPerSec(
	preference: ViewportPreference,
	viewportWidth: number,
	sourceDuration: number,
): number {
	const floor = fitFloorPxPerSec(viewportWidth, sourceDuration);
	if (!(floor > 0)) return 0;
	if (preference.kind === "fit") return floor;
	return clampEditingDensity(
		preference.pixelsPerSecond,
		viewportWidth,
		sourceDuration,
	);
}

export function stepEditingDensity(
	preference: ViewportPreference,
	factor: number,
	viewportWidth: number,
	sourceDuration: number,
): ViewportPreference {
	const floor = fitFloorPxPerSec(viewportWidth, sourceDuration);
	if (!(floor > 0) || !Number.isFinite(factor) || factor <= 0) {
		return { kind: "fit" };
	}
	const next = clampEditingDensity(
		effectivePxPerSec(preference, viewportWidth, sourceDuration) * factor,
		viewportWidth,
		sourceDuration,
	);
	if (next <= floor * (1 + 1e-6)) return { kind: "fit" };
	return { kind: "density", pixelsPerSecond: next };
}

export function preferenceFromSliderStop(
	stop: number,
	viewportWidth: number,
	sourceDuration: number,
): ViewportPreference {
	const floor = fitFloorPxPerSec(viewportWidth, sourceDuration);
	const max = effectiveMaxPxPerSec(viewportWidth, sourceDuration);
	if (!(floor > 0) || !(max > floor) || !Number.isFinite(stop) || stop <= 0) {
		return { kind: "fit" };
	}
	const t =
		Math.min(ZOOM_SLIDER_INCREMENTS, Math.max(0, stop)) /
		ZOOM_SLIDER_INCREMENTS;
	return {
		kind: "density",
		pixelsPerSecond: floor * (max / floor) ** t,
	};
}

export function sliderStopForPreference(
	preference: ViewportPreference,
	viewportWidth: number,
	sourceDuration: number,
): number {
	if (preference.kind === "fit") return 0;
	const floor = fitFloorPxPerSec(viewportWidth, sourceDuration);
	const max = effectiveMaxPxPerSec(viewportWidth, sourceDuration);
	if (!(floor > 0) || !(max > floor)) return 0;
	const pps = clampEditingDensity(
		preference.pixelsPerSecond,
		viewportWidth,
		sourceDuration,
	);
	const t = Math.log(pps / floor) / Math.log(max / floor);
	if (!Number.isFinite(t)) return 0;
	return Math.round(Math.min(1, Math.max(0, t)) * ZOOM_SLIDER_INCREMENTS);
}

export function relativeZoomForPreference(
	preference: ViewportPreference,
	viewportWidth: number,
	sourceDuration: number,
): number {
	const floor = fitFloorPxPerSec(viewportWidth, sourceDuration);
	const pps = effectivePxPerSec(preference, viewportWidth, sourceDuration);
	if (!(floor > 0) || !(pps > 0)) return 1;
	return pps / floor;
}

export function formatZoomMeasure(value: number): string {
	if (!Number.isFinite(value) || value < 0) return "0";
	const rounded = Math.round(value * 1000) / 1000;
	return String(rounded);
}

export function formatRulerLabel(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const minutes = Math.floor(total / 60);
	const remain = total % 60;
	return `${minutes}:${String(remain).padStart(2, "0")}`;
}

export function rulerTicks(input: {
	sourceDuration: number;
	scrollLeft: number;
	viewportWidth: number;
	zoom: number;
}): { time: number; leftPercent: number; label: string; major: boolean }[] {
	if (!(input.sourceDuration > 0) || !(input.viewportWidth > 0)) return [];
	const sourceWindow = visibleSourceWindow(input);
	const span = Math.max(sourceWindow.end - sourceWindow.start, 0.001);
	const raw = span / Math.max(1, input.viewportWidth / 80);
	const step = RULER_STEPS.find((candidate) => candidate >= raw) ?? 3600;
	const first = Math.ceil((sourceWindow.start - 1e-9) / step) * step;
	const ticks: {
		time: number;
		leftPercent: number;
		label: string;
		major: boolean;
	}[] = [];
	for (let time = first; time <= sourceWindow.end + 1e-9; time += step) {
		const rounded = Math.round(time * 1000) / 1000;
		ticks.push({
			time: rounded,
			leftPercent: (rounded / input.sourceDuration) * 100,
			label: formatRulerLabel(rounded),
			major: true,
		});
		if (ticks.length >= 48) break;
	}
	return ticks;
}

export function EditorTimelineRuler({
	duration,
	scrollLeft,
	viewportWidth,
	zoom,
}: {
	duration: number;
	scrollLeft: number;
	viewportWidth: number;
	zoom: number;
}) {
	const ticks = rulerTicks({
		sourceDuration: duration,
		scrollLeft,
		viewportWidth,
		zoom,
	});
	return (
		<div
			data-timeline-ruler=""
			className="relative h-[22px] overflow-hidden border-b border-white/10"
		>
			{ticks.map((tick) => (
				<div
					key={`${tick.time}`}
					data-ruler-tick=""
					data-source-time={tick.time}
					className="absolute top-0 flex h-full items-start"
					style={{ left: `${tick.leftPercent}%` }}
				>
					<span className="mt-3 h-2 w-px bg-white/70" />
					<span className="pl-1 font-mono text-[10px] font-medium tabular-nums text-white/80">
						{tick.label}
					</span>
				</div>
			))}
		</div>
	);
}

export const EditorPlayhead = forwardRef<HTMLDivElement, { label: string }>(
	function EditorPlayhead({ label }, ref) {
		return (
			<div
				data-playhead-overlay=""
				className="pointer-events-none absolute left-0 right-0 top-0 z-40 h-[104px] overflow-hidden"
			>
				<div
					ref={ref}
					data-playhead=""
					className="absolute bottom-0 left-0 top-0 will-change-transform"
					style={{
						transform: "translate3d(-9999px, 0, 0) translateX(-50%)",
					}}
				>
					<div
						data-playhead-triangle=""
						data-top-px="8"
						className="absolute left-1/2 size-0 -translate-x-1/2 border-x-[6px] border-t-[10px] border-x-transparent border-t-[#e5484d]"
						style={{ top: "8px" }}
					/>
					<div className="absolute left-1/2 top-0.5 ml-2 whitespace-nowrap rounded-md bg-white px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-black shadow-[0_2px_8px_rgba(0,0,0,0.45)]">
						{label}
					</div>
					<div
						data-playhead-line=""
						data-top-px="40"
						data-height-px="64"
						className="absolute left-1/2 w-0.5 -translate-x-1/2 bg-[#e5484d]"
						style={{
							top: `${PLAYHEAD_LINE_TOP_PX}px`,
							height: `${TIMELINE_WAVEFORM_PX}px`,
						}}
					/>
				</div>
			</div>
		);
	},
);

export function EditorHoverGhost({ fraction }: { fraction: number | null }) {
	if (fraction === null) return <div data-hover-ghost="" className="hidden" />;
	return (
		<div
			data-hover-ghost=""
			data-top-px="40"
			data-height-px="64"
			className="pointer-events-none absolute z-[15] w-px bg-[#5eb1ef]"
			style={{
				left: `${fraction * 100}%`,
				top: `${PLAYHEAD_LINE_TOP_PX}px`,
				height: `${TIMELINE_WAVEFORM_PX}px`,
			}}
		/>
	);
}

export function EditorWaveformCanvas({
	pairs,
	noAudio,
	duration,
	deleted,
	hidden,
	scrollLeft,
	viewportWidth,
	zoom,
}: {
	pairs: readonly PeakPair[] | null;
	noAudio: boolean;
	duration: number;
	deleted: readonly { start: number; end: number }[];
	hidden: boolean;
	scrollLeft: number;
	viewportWidth: number;
	zoom: number;
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || hidden) return;
		const width = Math.max(1, Math.floor(viewportWidth));
		const height = TIMELINE_WAVEFORM_PX;
		const dpr = Math.min(3, window.devicePixelRatio || 1);
		canvas.width = Math.floor(width * dpr);
		canvas.height = Math.floor(height * dpr);
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;
		canvas.style.left = `${scrollLeft}px`;
		let context: CanvasRenderingContext2D | null = null;
		try {
			context = canvas.getContext("2d");
		} catch {
			return;
		}
		if (!context) return;
		const sourceWindow = visibleSourceWindow({
			sourceDuration: duration,
			scrollLeft,
			viewportWidth: width,
			zoom,
		});
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		context.clearRect(0, 0, width, height);
		const mid = height / 2;
		if (!pairs || noAudio || pairs.length === 0) {
			context.fillStyle = "#8d8d8d";
			context.fillRect(0, mid, width, 1);
			return;
		}
		const columns = waveformColumns({
			pairs,
			windowStart: sourceWindow.start,
			windowEnd: sourceWindow.end,
			width,
			deleted,
		});
		const span = sourceWindow.end - sourceWindow.start;
		if (!Number.isFinite(span) || span <= 0) return;
		const visibleDeleted = deleted
			.filter(
				(range) =>
					range.end > range.start &&
					range.start < sourceWindow.end &&
					range.end > sourceWindow.start,
			)
			.map((range) => ({
				start: Math.max(0, ((range.start - sourceWindow.start) * width) / span),
				end: Math.min(width, ((range.end - sourceWindow.start) * width) / span),
			}))
			.sort((a, b) => a.start - b.start);
		const mergedDeleted: { start: number; end: number }[] = [];
		for (const range of visibleDeleted) {
			const previous = mergedDeleted[mergedDeleted.length - 1];
			if (previous && range.start <= previous.end) {
				previous.end = Math.max(previous.end, range.end);
			} else {
				mergedDeleted.push(range);
			}
		}
		let deletedIndex = 0;
		for (const [index, column] of columns.entries()) {
			const bar = Math.max(
				1,
				column.amplitude ** WAVEFORM_GAMMA * (height - 8),
			);
			let pixel = index;
			while (pixel < index + 1) {
				while (
					deletedIndex < mergedDeleted.length &&
					(mergedDeleted[deletedIndex]?.end ?? 0) <= pixel
				) {
					deletedIndex += 1;
				}
				const range = mergedDeleted[deletedIndex];
				const removed = range !== undefined && range.start <= pixel;
				const end = Math.min(
					index + 1,
					removed ? range.end : (range?.start ?? index + 1),
				);
				context.fillStyle = removed ? "#c4c4c4" : "#0090ff";
				context.fillRect(pixel, mid - bar / 2, end - pixel, bar);
				pixel = end;
			}
		}
	}, [
		deleted,
		duration,
		hidden,
		noAudio,
		pairs,
		scrollLeft,
		viewportWidth,
		zoom,
	]);
	if (hidden) return null;
	return (
		<canvas
			ref={canvasRef}
			data-waveform-canvas=""
			data-no-audio={noAudio ? "" : undefined}
			className="pointer-events-none absolute top-0 z-[3]"
			aria-hidden
		/>
	);
}

export function waveformFetchUrl(videoId: string): string {
	return `/api/media/peaks?videoId=${encodeURIComponent(videoId)}`;
}

export function shouldResetWaveformFetch(input: {
	videoId: string;
	sourceSha256: string | null;
	previousVideoId: string | null;
	previousSha256: string | null;
}): boolean {
	return (
		input.videoId !== input.previousVideoId ||
		input.sourceSha256 !== input.previousSha256
	);
}

export { PEAKS_PAIRS_PER_SEC };

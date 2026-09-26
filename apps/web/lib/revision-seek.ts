import {
	type SeekClockFrame,
	startSeekClockPoll,
} from "@/lib/revision-seek-clock";

export const DEFAULT_FRAME_SPAN_SECONDS = 1 / 30;
export const OVERSHOOT_SLACK_SECONDS = 0.02;

export type TimeRangeLike = {
	length: number;
	start: (index: number) => number;
	end: (index: number) => number;
};

export type RevisionSeekVideo = {
	currentTime: number;
	duration: number;
	paused: boolean;
	pause: () => void;
	play: () => Promise<void> | void;
	buffered?: TimeRangeLike;
	requestVideoFrameCallback?: (
		callback: (now: number, metadata: { mediaTime: number }) => void,
	) => number;
};

export type RevisionSeekHls = {
	startLoad: (position?: number) => void;
	config?: Record<string, unknown>;
};

export type RevisionSeekResult = {
	pausedBeforeSeek: boolean;
	nudged: boolean;
	startedLoad: boolean;
	issuedTarget: number;
	corrected: boolean;
	correctionTarget: number | null;
	resumed: boolean;
};

export function bufferCoversTarget(
	buffered: TimeRangeLike | undefined,
	target: number,
): boolean {
	if (!buffered) return false;
	for (let index = 0; index < buffered.length; index++) {
		if (
			target >= buffered.start(index) - 1e-3 &&
			target < buffered.end(index) - 1e-4
		) {
			return true;
		}
	}
	return false;
}

export function clampSeekTarget(target: number, duration: number): number {
	if (!Number.isFinite(target)) return 0;
	if (Number.isFinite(duration) && duration > 0) {
		return Math.max(0, Math.min(duration - 0.001, target));
	}
	return Math.max(0, target);
}

function nudgeBack(target: number, span: number): number {
	const nudge = Math.min(0.008, Math.max(0.002, span / 4));
	return Math.max(0, target - nudge);
}

export async function revisionSeek(
	video: RevisionSeekVideo,
	hls: RevisionSeekHls | null,
	input: {
		target: number;
		frameStart?: number;
		frameSpanSeconds?: number;
		resume?: boolean;
		correctOvershoot?: boolean;
		requestFrame?: SeekClockFrame;
	},
): Promise<RevisionSeekResult> {
	const span = input.frameSpanSeconds ?? DEFAULT_FRAME_SPAN_SECONDS;
	const frameStart = input.frameStart ?? input.target;
	const target = clampSeekTarget(input.target, video.duration);
	const wasPlaying = !video.paused;
	const resume = input.resume ?? wasPlaying;
	video.pause();
	let nudged = false;
	if (Math.abs(video.currentTime - target) < 5e-4) {
		video.currentTime = nudgeBack(target, span);
		nudged = true;
	}
	const startedLoad =
		Boolean(hls) && !bufferCoversTarget(video.buffered, target);
	if (startedLoad && hls) {
		hls.startLoad(target);
	}
	video.currentTime = target;
	startSeekClockPoll(video, { requestFrame: input.requestFrame });
	let corrected = false;
	let correctionTarget: number | null = null;
	const shouldCorrect = input.correctOvershoot !== false;
	if (shouldCorrect && video.requestVideoFrameCallback) {
		const mediaTime = await new Promise<number | null>((resolve) => {
			const timer = setTimeout(() => resolve(null), 2000);
			video.requestVideoFrameCallback?.((_now, metadata) => {
				clearTimeout(timer);
				resolve(metadata.mediaTime);
			});
		});
		const overshootAt = frameStart + span + OVERSHOOT_SLACK_SECONDS;
		if (typeof mediaTime === "number" && mediaTime >= overshootAt) {
			correctionTarget = frameStart + span / 2;
			video.pause();
			video.currentTime = clampSeekTarget(correctionTarget, video.duration);
			corrected = true;
		}
	}
	let resumed = false;
	if (resume) {
		await video.play();
		resumed = true;
	}
	return {
		pausedBeforeSeek: true,
		nudged,
		startedLoad,
		issuedTarget: target,
		corrected,
		correctionTarget,
		resumed,
	};
}

type SeekBinding = {
	getHls: () => RevisionSeekHls | null;
	wasPlayingBeforeDrag: boolean;
	dragPaused: boolean;
};

const bindings = new WeakMap<HTMLVideoElement, SeekBinding>();

export function bindRevisionSeek(
	video: HTMLVideoElement,
	getHls: () => RevisionSeekHls | null,
) {
	bindings.set(video, {
		getHls,
		wasPlayingBeforeDrag: false,
		dragPaused: false,
	});
}

export function unbindRevisionSeek(video: HTMLVideoElement) {
	bindings.delete(video);
}

export function hasRevisionSeekBinding(video: HTMLVideoElement): boolean {
	return bindings.has(video);
}

export function revisionDragStart(video: HTMLVideoElement): boolean {
	const binding = bindings.get(video);
	if (!binding || binding.dragPaused) return false;
	binding.wasPlayingBeforeDrag = !video.paused;
	video.pause();
	binding.dragPaused = true;
	return true;
}

export function revisionDragCommit(
	video: HTMLVideoElement,
	target: number,
): boolean {
	const binding = bindings.get(video);
	if (!binding) return false;
	const resume = binding.wasPlayingBeforeDrag;
	binding.dragPaused = false;
	void revisionSeek(video, binding.getHls(), { target, resume });
	return true;
}

export function revisionDiscreteSeek(
	video: HTMLVideoElement,
	target: number,
): boolean {
	const binding = bindings.get(video);
	if (!binding) return false;
	void revisionSeek(video, binding.getHls(), { target });
	return true;
}

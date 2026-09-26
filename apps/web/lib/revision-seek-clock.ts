export type SeekClockMedia = {
	currentTime: number;
	addEventListener?: (type: string, listener: () => void) => void;
	removeEventListener?: (type: string, listener: () => void) => void;
};

export type SeekClockFrame = (callback: () => void) => number;

export const SEEK_CLOCK_POLL_FRAMES = 8;

const listeners = new WeakMap<object, Set<(time: number) => void>>();

export function subscribeSeekClock(
	media: object,
	onSample: (time: number) => void,
): () => void {
	let set = listeners.get(media);
	if (!set) {
		set = new Set();
		listeners.set(media, set);
	}
	set.add(onSample);
	return () => {
		set?.delete(onSample);
	};
}

function defaultFrame(callback: () => void): number {
	if (typeof requestAnimationFrame === "function") {
		return requestAnimationFrame(callback);
	}
	return setTimeout(callback, 16) as unknown as number;
}

export function sampleClockUntilSeeked(
	media: SeekClockMedia,
	onSample: (time: number) => void,
	options?: {
		requestFrame?: SeekClockFrame;
		maxFrames?: number;
	},
): () => void {
	const requestFrame = options?.requestFrame ?? defaultFrame;
	const maxFrames = options?.maxFrames ?? SEEK_CLOCK_POLL_FRAMES;
	let stopped = false;
	let frames = 0;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		media.removeEventListener?.("seeked", onSeeked);
	};
	const onSeeked = () => {
		onSample(media.currentTime);
		stop();
	};
	media.addEventListener?.("seeked", onSeeked);
	const tick = () => {
		if (stopped) return;
		onSample(media.currentTime);
		frames += 1;
		if (frames >= maxFrames) {
			stop();
			return;
		}
		requestFrame(tick);
	};
	tick();
	return stop;
}

export function startSeekClockPoll(
	media: SeekClockMedia,
	options?: {
		requestFrame?: SeekClockFrame;
		maxFrames?: number;
	},
): void {
	sampleClockUntilSeeked(
		media,
		(time) => {
			const set = listeners.get(media);
			if (!set) return;
			for (const listener of set) listener(time);
		},
		options,
	);
}

export function reconcileSeekSample(
	storeTime: number,
	sampledTime: number | null,
	elementTime: number,
): number | null {
	if (sampledTime == null || !Number.isFinite(sampledTime)) return null;
	if (!Number.isFinite(elementTime) || !Number.isFinite(storeTime)) return null;
	if (Math.abs(sampledTime - storeTime) <= 0.05) return null;
	if (
		Math.abs(elementTime - sampledTime) > 0.05 &&
		Math.abs(elementTime - storeTime) <= 0.05
	) {
		return null;
	}
	return sampledTime;
}

export function displayedSeekTime(
	storeTime: number,
	sampledTime: number | null,
	elementTime?: number,
): number {
	if (elementTime == null) {
		if (sampledTime == null || !Number.isFinite(sampledTime)) return storeTime;
		if (Math.abs(sampledTime - storeTime) <= 0.05) return storeTime;
		return sampledTime;
	}
	const kept = reconcileSeekSample(storeTime, sampledTime, elementTime);
	return kept == null ? storeTime : kept;
}

const watched = new WeakMap<object, number>();

export function watchElementClock(
	media: SeekClockMedia,
	options?: { requestFrame?: SeekClockFrame },
): () => void {
	const requestFrame = options?.requestFrame ?? defaultFrame;
	let stopped = false;
	let last = media.currentTime;
	const tick = () => {
		if (stopped) return;
		if (media.currentTime !== last) {
			last = media.currentTime;
			watched.set(media, last);
			startSeekClockPoll(media, { requestFrame });
		}
		requestFrame(tick);
	};
	requestFrame(tick);
	return () => {
		stopped = true;
	};
}

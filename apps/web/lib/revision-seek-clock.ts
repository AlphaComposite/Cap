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

export function displayedSeekTime(
	storeTime: number,
	sampledTime: number | null,
): number {
	if (sampledTime == null || !Number.isFinite(sampledTime)) return storeTime;
	if (Math.abs(sampledTime - storeTime) <= 0.05) return storeTime;
	return sampledTime;
}

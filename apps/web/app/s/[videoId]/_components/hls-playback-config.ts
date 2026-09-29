import type { HlsConfig } from "hls.js";

type PlaybackHlsConfigInput = {
	startPosition: number;
	loader: HlsConfig["loader"];
};

function sharedPlaybackHlsConfig(input: PlaybackHlsConfigInput) {
	return {
		enableWorker: true,
		lowLatencyMode: false,
		backBufferLength: 90,
		startFragPrefetch: true,
		startPosition: input.startPosition,
		loader: input.loader,
	} satisfies Partial<HlsConfig>;
}

export function createVodHlsConfig(input: PlaybackHlsConfigInput) {
	return {
		...sharedPlaybackHlsConfig(input),
		maxBufferHole: 0.5,
	} satisfies Partial<HlsConfig>;
}

export function createLiveSegmentsHlsConfig(input: PlaybackHlsConfigInput) {
	return {
		...sharedPlaybackHlsConfig(input),
		liveSyncDurationCount: 3,
		liveMaxLatencyDurationCount: 6,
		manifestLoadingRetryDelay: 2000,
		manifestLoadingMaxRetry: 30,
		levelLoadingRetryDelay: 2000,
		levelLoadingMaxRetry: 30,
		fragLoadingRetryDelay: 2000,
		fragLoadingMaxRetry: 30,
	} satisfies Partial<HlsConfig>;
}

import type { HlsConfig } from "hls.js";
import { describe, expect, it } from "vitest";
import {
	createLiveSegmentsHlsConfig,
	createVodHlsConfig,
} from "@/app/s/[videoId]/_components/hls-playback-config";

const loader = class SentinelLoader {} as unknown as HlsConfig["loader"];

const input = { startPosition: 12.5, loader };

describe("hls playback config", () => {
	it("tolerates small VOD buffer holes without dropping the existing VOD options", () => {
		const config = createVodHlsConfig(input);

		expect(config.maxBufferHole).toBe(0.5);
		expect(config.enableWorker).toBe(true);
		expect(config.lowLatencyMode).toBe(false);
		expect(config.backBufferLength).toBe(90);
		expect(config.startFragPrefetch).toBe(true);
		expect(config.loader).toBe(loader);
		expect(config.startPosition).toBe(12.5);
		expect(config).not.toHaveProperty("manifestLoadingMaxRetry");
		expect(config).not.toHaveProperty("fragLoadingMaxRetry");
	});

	it("keeps live-segment retry settings and does not raise maxBufferHole", () => {
		const config = createLiveSegmentsHlsConfig(input);

		expect(config.manifestLoadingRetryDelay).toBe(2000);
		expect(config.manifestLoadingMaxRetry).toBe(30);
		expect(config.levelLoadingRetryDelay).toBe(2000);
		expect(config.levelLoadingMaxRetry).toBe(30);
		expect(config.fragLoadingRetryDelay).toBe(2000);
		expect(config.fragLoadingMaxRetry).toBe(30);
		expect(config.liveSyncDurationCount).toBe(3);
		expect(config.liveMaxLatencyDurationCount).toBe(6);
		expect(config.enableWorker).toBe(true);
		expect(config.lowLatencyMode).toBe(false);
		expect(config.backBufferLength).toBe(90);
		expect(config.startFragPrefetch).toBe(true);
		expect(config.loader).toBe(loader);
		expect(config).not.toHaveProperty("maxBufferHole");
	});
});

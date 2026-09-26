import { describe, expect, it } from "vitest";
import {
	clearPrefetchedFragments,
	readPrefetchedFragment,
	rememberPrefetchedFragment,
} from "@/lib/instant-finish-fragment-cache";
import {
	INSTANT_FINISH_PLAYBACK_KEY,
	preferInstantFinishFirstPaint,
	stashInstantFinishPlayback,
} from "@/lib/instant-finish-playback-handoff";
import type { ClientRevisionPlayback } from "@/lib/revision-playback";

const metadata = {
	duration: 12,
	chapters: [{ title: "Cut", start: 0 }],
	captionsAvailable: false,
	commentTimestamps: {},
	thumbnailAvailable: false,
	downloadReady: false,
	playlistPath: "/media/video-1/r/rev-new/playlist.m3u8",
	summaryStatus: "persisted" as const,
	summaryDerived: false as const,
	summaryText: null,
	captions: "unavailable" as const,
	chaptersStatus: "revision" as const,
	thumbnail: "seg0-first-frame" as const,
	download: "preparing" as const,
	commentClock: "output-time" as const,
	removedRangeComments: "hidden" as const,
};

const ssr: ClientRevisionPlayback = {
	mode: "hls",
	videoId: "video-1",
	revisionId: "rev-new",
	generation: 2,
	playlistUrl: "/media/video-1/r/rev-new/playlist.m3u8?t=ssr-grant",
	duration: 12,
	captionsUrl: null,
	chapters: [{ title: "Cut", start: 0 }],
	commentTimestamps: {},
	thumbnailUrl: null,
	downloadReady: false,
};

function storage() {
	const bag = new Map<string, string>();
	return {
		getItem: (key: string) => bag.get(key) ?? null,
		setItem: (key: string, value: string) => {
			bag.set(key, value);
		},
		removeItem: (key: string) => {
			bag.delete(key);
		},
	};
}

describe("instant finish fragment cache", () => {
	it("consumes a prefetched fragment once and keeps at most three startup fragments of one revision", () => {
		clearPrefetchedFragments();
		const first = new Uint8Array([1]).buffer;
		const url = "http://127.0.0.1/media/video-1/r/rev-a/init.mp4?t=grant";
		rememberPrefetchedFragment(url, first);
		expect(readPrefetchedFragment(url)).toBe(first);
		expect(readPrefetchedFragment(url)).toBeNull();

		rememberPrefetchedFragment(
			"http://127.0.0.1/media/video-1/r/rev-a/init.mp4?t=grant",
			new Uint8Array([1]).buffer,
		);
		rememberPrefetchedFragment(
			"http://127.0.0.1/media/video-1/r/rev-a/seg/0.m4s?t=grant",
			new Uint8Array([2]).buffer,
		);
		rememberPrefetchedFragment(
			"http://127.0.0.1/media/video-1/r/rev-a/seg/1.m4s?t=grant",
			new Uint8Array([3]).buffer,
		);
		rememberPrefetchedFragment(
			"http://127.0.0.1/media/video-1/r/rev-a/seg/2.m4s?t=grant",
			new Uint8Array([4]).buffer,
		);
		rememberPrefetchedFragment(
			"http://127.0.0.1/media/video-1/r/rev-b/init.mp4?t=grant",
			new Uint8Array([9]).buffer,
		);
		expect(
			readPrefetchedFragment(
				"http://127.0.0.1/media/video-1/r/rev-a/init.mp4?t=grant",
			),
		).toBeNull();
		expect(
			readPrefetchedFragment(
				"http://127.0.0.1/media/video-1/r/rev-b/init.mp4?t=grant",
			)?.byteLength,
		).toBe(1);
	});
});

describe("instant finish playback handoff", () => {
	it("removes the session key when the handoff is consumed or expired", () => {
		const consumed = storage();
		stashInstantFinishPlayback(
			{
				videoId: "video-1",
				revisionId: "rev-new",
				generation: 2,
				playlistUrl: "/media/video-1/r/rev-new/playlist.m3u8?t=publish-grant",
				grantExpiresAt: 1_700_000_060,
				revisionMetadata: metadata,
			},
			consumed,
		);
		const preferred = preferInstantFinishFirstPaint({
			videoId: "video-1",
			ssr,
			storage: consumed,
			nowMs: 1_700_000_000_000,
		});
		expect(preferred.fromHandoff).toBe(true);
		expect(consumed.getItem(INSTANT_FINISH_PLAYBACK_KEY)).toBeNull();

		const expired = storage();
		stashInstantFinishPlayback(
			{
				videoId: "video-1",
				revisionId: "rev-new",
				generation: 2,
				playlistUrl: "/media/video-1/r/rev-new/playlist.m3u8?t=publish-grant",
				grantExpiresAt: 1_700_000_060,
				revisionMetadata: metadata,
			},
			expired,
		);
		preferInstantFinishFirstPaint({
			videoId: "video-1",
			ssr,
			storage: expired,
			nowMs: 1_700_000_061_000,
		});
		expect(expired.getItem(INSTANT_FINISH_PLAYBACK_KEY)).toBeNull();
	});
});

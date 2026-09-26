import { describe, expect, it } from "vitest";
import {
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

describe("instant finish playback handoff", () => {
	it("prefers a matching unexpired stash and falls back otherwise", () => {
		const box = storage();
		stashInstantFinishPlayback(
			{
				videoId: "video-1",
				revisionId: "rev-new",
				generation: 2,
				playlistUrl: "/media/video-1/r/rev-new/playlist.m3u8?t=publish-grant",
				grantExpiresAt: 1_700_000_060,
				revisionMetadata: metadata,
			},
			box,
		);
		const preferred = preferInstantFinishFirstPaint({
			videoId: "video-1",
			ssr,
			storage: box,
			nowMs: 1_700_000_000_000,
		});
		expect(preferred.fromHandoff).toBe(true);
		expect(preferred.playback?.mode).toBe("hls");
		if (preferred.playback?.mode === "hls") {
			expect(preferred.playback.playlistUrl).toContain("publish-grant");
			expect(preferred.playback.revisionId).toBe("rev-new");
		}
		expect(JSON.stringify(preferred)).not.toContain("/s/video-1?");

		const expired = preferInstantFinishFirstPaint({
			videoId: "video-1",
			ssr,
			storage: box,
			nowMs: 1_700_000_061_000,
		});
		expect(expired.fromHandoff).toBe(false);
		if (expired.playback?.mode === "hls") {
			expect(expired.playback.playlistUrl).toContain("ssr-grant");
		}

		const mismatch = preferInstantFinishFirstPaint({
			videoId: "video-1",
			ssr: { ...ssr, revisionId: "rev-old" },
			storage: box,
			nowMs: 1_700_000_000_000,
		});
		expect(mismatch.fromHandoff).toBe(false);
		if (mismatch.playback?.mode === "hls") {
			expect(mismatch.playback.playlistUrl).toContain("ssr-grant");
		}
	});
});

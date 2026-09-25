import { describe, expect, it } from "vitest";
import {
	planDoneAfterPublish,
	readOrCreateDraftSession,
} from "@/lib/revision-done";
import {
	applyRevisionCommentTimes,
	buildClientRevisionPlayback,
	buildRevisionAssetUrl,
	filmstripForRevision,
	planGrantRefresh,
	planSharePlayback,
	publicRevisionPlaylistUrl,
	redactMediaGrant,
	replacePlaylistGrant,
} from "@/lib/revision-playback";
import type { InstantFinishPublicationDto } from "@/lib/revision-publication-read";
import {
	bindRevisionSeek,
	bufferCoversTarget,
	type RevisionSeekVideo,
	revisionDragCommit,
	revisionDragStart,
	revisionSeek,
} from "@/lib/revision-seek";
import {
	buildShareVideoMetadata,
	getShareVideoUrls,
} from "@/lib/share-video-metadata";

const publication = (
	overrides: Partial<InstantFinishPublicationDto> = {},
): InstantFinishPublicationDto => ({
	enabled: true,
	currentRevisionId: "rev-1",
	generation: 2,
	duration: 12.5,
	draftVersion: 4,
	draftSession: "session-1",
	revisionMetadata: {
		duration: 11,
		chapters: [{ title: "Intro", start: 1.25 }],
		captionsAvailable: true,
		commentTimestamps: { c1: 2.5, c2: null },
		thumbnailAvailable: false,
		downloadReady: false,
		playlistPath: "/media/video-1/r/rev-1/playlist.m3u8",
		summaryStatus: "persisted",
		summaryDerived: false,
		summaryText: null,
		captions: "revision",
		chaptersStatus: "revision",
		thumbnail: "unavailable",
		download: "preparing",
		commentClock: "output-time",
		removedRangeComments: "hidden",
	},
	...overrides,
});

describe("revision playback plan", () => {
	it("skips the signed MP4 prefetch and forces HLS for a flagged video", () => {
		const plan = planSharePlayback({
			enabled: true,
			currentRevisionId: "rev-1",
			isScreenshot: false,
			hasActiveUpload: false,
			sourceType: "webMP4",
		});
		expect(plan).toEqual({
			prefetchResultMp4: false,
			player: "hls",
			omitRawFallback: true,
			blockProcessingOverlay: false,
		});
	});

	it("keeps the MP4 prefetch for an unflagged webMP4", () => {
		expect(
			planSharePlayback({
				enabled: false,
				currentRevisionId: null,
				isScreenshot: false,
				hasActiveUpload: false,
				sourceType: "desktopMP4",
			}).prefetchResultMp4,
		).toBe(true);
	});

	it("builds a tokenized revision playlist and never an /api/playlist mp4 URL", () => {
		const playback = buildClientRevisionPlayback({
			publication: publication(),
			videoId: "video-1",
			origin: "https://cap.example.com",
			grant: "grant-secret",
		});
		expect(playback?.mode).toBe("hls");
		if (playback?.mode !== "hls") throw new Error("expected hls");
		expect(playback.playlistUrl).toBe(
			"https://cap.example.com/media/video-1/r/rev-1/playlist.m3u8?t=grant-secret",
		);
		expect(playback.playlistUrl).not.toContain("/api/playlist");
		expect(playback.playlistUrl).not.toContain("result.mp4");
		expect(playback.captionsUrl).toContain("captions.vtt?t=grant-secret");
		expect(playback.downloadReady).toBe(false);
		expect(playback.thumbnailUrl).toBeNull();
		expect(redactMediaGrant(playback.playlistUrl)).not.toContain(
			"grant-secret",
		);
	});

	it("marks a flagged video without a current revision unavailable", () => {
		const playback = buildClientRevisionPlayback({
			publication: publication({
				currentRevisionId: null,
			}),
			videoId: "video-1",
			origin: "https://cap.example.com",
			grant: null,
		});
		expect(playback).toEqual({
			mode: "unavailable",
			videoId: "video-1",
			generation: 2,
			downloadReady: false,
		});
	});

	it("advertises HLS metadata and omits the previous thumbnail when R1 has none", () => {
		const urls = getShareVideoUrls({
			videoId: "video-1",
			sourceType: "webMP4",
			webUrl: "https://cap.example.com",
			revisionStreamUrl: publicRevisionPlaylistUrl({
				origin: "https://cap.example.com",
				videoId: "video-1",
				revisionId: "rev-1",
			}),
			revisionThumbnailUnavailable: true,
		});
		expect(urls.streamUrl).toBe(
			"https://cap.example.com/media/video-1/r/rev-1/playlist.m3u8",
		);
		expect(urls.streamContentType).toBe("application/vnd.apple.mpegurl");
		expect(urls.streamUrl).not.toContain("videoType=mp4");
		expect(urls.previewImageUrl).toBeNull();
		const metadata = buildShareVideoMetadata({
			videoId: "video-1",
			name: "Demo",
			sourceType: "webMP4",
			webUrl: "https://cap.example.com",
			revisionStreamUrl: urls.streamUrl ?? undefined,
			revisionThumbnailUnavailable: true,
		});
		const videos =
			metadata.openGraph && "videos" in metadata.openGraph
				? metadata.openGraph.videos
				: undefined;
		expect(Array.isArray(videos) ? videos[0] : videos).toMatchObject({
			type: "application/vnd.apple.mpegurl",
		});
	});

	it("hides comments that the revision mapping did not keep", () => {
		expect(
			applyRevisionCommentTimes(
				[
					{ id: "c1", timestamp: 90 },
					{ id: "c2", timestamp: 40 },
					{ id: "c3", timestamp: 10 },
				],
				{ c1: 2.5, c2: null },
			),
		).toEqual([
			{ id: "c1", timestamp: 2.5 },
			{ id: "c2", timestamp: null },
			{ id: "c3", timestamp: null },
		]);
	});

	it("uses the revision playlist for the filmstrip and drops the old MP4 kind", () => {
		const playback = buildClientRevisionPlayback({
			publication: publication(),
			videoId: "video-1",
			origin: "",
			grant: "grant",
		});
		expect(
			filmstripForRevision(playback, {
				src: "/api/playlist?videoType=mp4",
				kind: "native",
			}),
		).toEqual({
			src: "/media/video-1/r/rev-1/playlist.m3u8?t=grant",
			kind: "hls",
		});
	});

	it("refreshes the same revision grant and reloads the page when publication changes", () => {
		expect(
			planGrantRefresh({
				status: 200,
				revisionId: "rev-1",
				body: { revisionId: "rev-1", grant: "next" },
			}),
		).toBe("reload-same");
		expect(
			replacePlaylistGrant(
				"https://cap.example.com/media/video-1/r/rev-1/playlist.m3u8?t=old",
				"next",
			),
		).toBe("https://cap.example.com/media/video-1/r/rev-1/playlist.m3u8?t=next");
		expect(
			planGrantRefresh({
				status: 410,
				revisionId: "rev-1",
				body: { changed: true },
			}),
		).toBe("refresh-page");
	});
});

describe("revision seek", () => {
	function fakeVideo(
		overrides: Partial<RevisionSeekVideo> = {},
	): RevisionSeekVideo & {
		times: number[];
		plays: number;
		pauses: number;
	} {
		const video = {
			currentTime: 0,
			duration: 30,
			paused: false,
			times: [] as number[],
			plays: 0,
			pauses: 0,
			pause() {
				this.pauses += 1;
				this.paused = true;
			},
			play() {
				this.plays += 1;
				this.paused = false;
			},
			buffered: { length: 0, start: () => 0, end: () => 0 },
			...overrides,
		};
		Object.defineProperty(video, "currentTime", {
			get() {
				return this.times.at(-1) ?? 0;
			},
			set(value: number) {
				this.times.push(value);
			},
		});
		return video;
	}

	it("pauses before a cold seek, starts load, and resumes", async () => {
		const video = fakeVideo();
		const starts: number[] = [];
		const result = await revisionSeek(
			video,
			{ startLoad: (position) => starts.push(position ?? -1) },
			{ target: 8, resume: true, correctOvershoot: false },
		);
		expect(result.pausedBeforeSeek).toBe(true);
		expect(video.pauses).toBeGreaterThan(0);
		expect(result.startedLoad).toBe(true);
		expect(starts).toEqual([8]);
		expect(video.times).toContain(8);
		expect(result.resumed).toBe(true);
	});

	it("re-seeks to mid-span when the first frame overshoots", async () => {
		const video = fakeVideo({
			requestVideoFrameCallback: (callback) => {
				callback(0, { mediaTime: 8.2 });
				return 1;
			},
		});
		const result = await revisionSeek(video, null, {
			target: 8,
			frameStart: 8,
			frameSpanSeconds: 1 / 30,
			resume: false,
		});
		expect(result.corrected).toBe(true);
		expect(result.correctionTarget).toBeCloseTo(8 + 1 / 60, 5);
		expect(video.times.at(-1)).toBeCloseTo(8 + 1 / 60, 5);
		expect(result.resumed).toBe(false);
	});

	it("does not startLoad when the target is already buffered", async () => {
		const video = fakeVideo({
			paused: true,
			buffered: {
				length: 1,
				start: () => 0,
				end: () => 20,
			},
		});
		expect(bufferCoversTarget(video.buffered, 8)).toBe(true);
		const starts: number[] = [];
		const result = await revisionSeek(
			video,
			{ startLoad: (position) => starts.push(position ?? -1) },
			{ target: 8, correctOvershoot: false },
		);
		expect(result.startedLoad).toBe(false);
		expect(starts).toEqual([]);
		expect(result.resumed).toBe(false);
	});

	it("pauses once at drag start and corrects only on commit", () => {
		const pauses = { count: 0 };
		const element: {
			paused: boolean;
			currentTime: number;
			duration: number;
			pause: () => void;
			play: () => void;
		} = {
			paused: false,
			currentTime: 0,
			duration: 30,
			pause() {
				pauses.count += 1;
				this.paused = true;
			},
			play() {
				this.paused = false;
			},
		};
		const video = element as unknown as HTMLVideoElement;
		bindRevisionSeek(video, () => null);
		expect(revisionDragStart(video)).toBe(true);
		expect(revisionDragStart(video)).toBe(false);
		expect(pauses.count).toBe(1);
		expect(revisionDragCommit(video, 4)).toBe(true);
	});
});

describe("done publish plan", () => {
	it("keeps the editor draft on conflict and does not treat a stub as success", () => {
		expect(planDoneAfterPublish({ success: false, reason: "flag-off" })).toBe(
			"legacy",
		);
		expect(
			planDoneAfterPublish({
				success: false,
				status: 409,
				message: "retry",
			}),
		).toBe("conflict");
		expect(
			planDoneAfterPublish({
				success: true,
				revisionId: "rev-1",
				generation: 3,
			}),
		).toBe("published");
		expect(
			planDoneAfterPublish({
				success: false,
				status: 503,
				message: "unavailable",
			}),
		).toBe("error");
	});

	it("reuses a draft session instead of minting a new one", () => {
		const storage = new Map<string, string>();
		const adapter = {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => {
				storage.set(key, value);
			},
		};
		expect(readOrCreateDraftSession(adapter, "video-1")).toBe(
			readOrCreateDraftSession(adapter, "video-1"),
		);
	});
});

describe("revision asset urls", () => {
	it("keeps the grant on relative media paths", () => {
		expect(
			buildRevisionAssetUrl({
				origin: "",
				videoId: "video-1",
				revisionId: "rev-1",
				asset: "seg/0.m4s",
				grant: "abc",
			}),
		).toBe("/media/video-1/r/rev-1/seg/0.m4s?t=abc");
	});
});

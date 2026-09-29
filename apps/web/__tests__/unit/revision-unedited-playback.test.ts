import { afterEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => ({
	intent: [] as unknown[],
	edits: [] as unknown[],
	videos: [{ metadata: null }] as unknown[],
	source: [] as unknown[],
}));

vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	const answer = (table: unknown) => {
		if (table === schema.editIntent) return rows.intent;
		if (table === schema.videoEdits) return rows.edits;
		if (table === schema.videos) return rows.videos;
		if (table === schema.sourceObject) return rows.source;
		return [];
	};
	return {
		db: () => ({
			select: () => ({
				from: (table: unknown) => ({
					where: () => {
						const result = Promise.resolve(answer(table));
						return Object.assign(result, {
							limit: () => Promise.resolve(answer(table)),
						});
					},
				}),
			}),
		}),
	};
});

const publication = {
	enabled: true,
	currentRevisionId: null as string | null,
	generation: 1,
	duration: null,
	draftVersion: 0,
	draftSession: "",
	revisionMetadata: {
		duration: null,
		chapters: [],
		captionsAvailable: false,
		commentTimestamps: {},
		thumbnailAvailable: false,
		downloadReady: false,
		playlistPath: null,
		summaryStatus: "persisted" as const,
		summaryDerived: false as const,
		summaryText: null,
		captions: "unavailable" as const,
		chaptersStatus: "unavailable" as const,
		thumbnail: "unavailable" as const,
		download: "preparing" as const,
		commentClock: "output-time" as const,
		removedRangeComments: "hidden" as const,
	},
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/revision-media-grant", () => ({
	mintRevisionMediaGrant: async () => null,
}));
vi.mock("@/lib/revision-publication-read", () => ({
	getInstantFinishPublicationDto: async () => publication,
	disabledInstantFinishPublication: (
		overrides: Record<string, unknown> = {},
	) => ({
		...publication,
		enabled: false,
		...overrides,
	}),
}));

import {
	buildClientRevisionPlayback,
	planSharePlayback,
} from "@/lib/revision-playback";
import { loadRevisionPlayback } from "@/lib/revision-playback-load";

const flaggedEnv = {
	CAP_INSTANT_FINISH_OWNERS: "owner-flagged",
};

describe("eligible legacy playback", () => {
	afterEach(() => {
		delete process.env.CAP_INSTANT_FINISH_OWNERS;
		publication.enabled = true;
		publication.currentRevisionId = null;
		rows.intent = [];
		rows.edits = [];
		rows.videos = [{ metadata: null }];
		rows.source = [];
	});

	it("uses the legacy player for a flagged video with no intent and no relocation", async () => {
		process.env.CAP_INSTANT_FINISH_OWNERS = "owner-flagged";
		const plan = planSharePlayback({
			enabled: true,
			currentRevisionId: null,
			isScreenshot: false,
			hasActiveUpload: false,
			sourceType: "webMP4",
			eligibleLegacy: true,
		});
		expect(plan.player).toBe("legacy");
		expect(plan.prefetchResultMp4).toBe(true);

		const loaded = await loadRevisionPlayback({
			videoId: "video-1",
			ownerId: "owner-flagged",
			origin: "https://cap.test",
			isScreenshot: false,
			hasActiveUpload: false,
			sourceType: "webMP4",
			env: flaggedEnv,
		});
		expect(loaded.plan.player).toBe("legacy");
		expect(loaded.playback).toBeNull();
		expect(loaded.publicPlaylistUrl).toBeNull();
		expect(loaded.thumbnailUnavailable).toBe(false);

		const client = buildClientRevisionPlayback({
			publication,
			videoId: "video-1",
			origin: "https://cap.test",
			grant: null,
			eligibleLegacy: true,
		});
		expect(client).toBeNull();
	});

	it("stays unavailable when a flagged video has an intent or a purged private source", async () => {
		const intentPlan = planSharePlayback({
			enabled: true,
			currentRevisionId: null,
			isScreenshot: false,
			hasActiveUpload: false,
			sourceType: "webMP4",
			eligibleLegacy: false,
		});
		expect(intentPlan.player).toBe("unavailable");
		expect(intentPlan.omitRawFallback).toBe(true);

		const purged = buildClientRevisionPlayback({
			publication,
			videoId: "video-1",
			origin: "https://cap.test",
			grant: null,
			eligibleLegacy: false,
		});
		expect(purged).toEqual({
			mode: "unavailable",
			videoId: "video-1",
			generation: 1,
			downloadReady: false,
		});

		process.env.CAP_INSTANT_FINISH_OWNERS = "owner-flagged";
		rows.intent = [{ videoId: "video-1" }];
		const withIntent = await loadRevisionPlayback({
			videoId: "video-1",
			ownerId: "owner-flagged",
			origin: "https://cap.test",
			isScreenshot: false,
			hasActiveUpload: false,
			sourceType: "webMP4",
			env: flaggedEnv,
		});
		expect(withIntent.plan.player).toBe("unavailable");
		expect(withIntent.playback?.mode).toBe("unavailable");

		rows.intent = [];
		rows.source = [
			{
				relocationState: "PURGED",
				liveKey: "private/source/video-1/opaque",
			},
		];
		const relocated = await loadRevisionPlayback({
			videoId: "video-1",
			ownerId: "owner-flagged",
			origin: "https://cap.test",
			isScreenshot: false,
			hasActiveUpload: false,
			sourceType: "webMP4",
			env: flaggedEnv,
		});
		expect(relocated.plan.player).toBe("unavailable");
		expect(relocated.playback?.mode).toBe("unavailable");
	});

	it("keeps an unflagged owner on the legacy player even if an intent exists", () => {
		expect(
			planSharePlayback({
				enabled: false,
				currentRevisionId: null,
				isScreenshot: false,
				hasActiveUpload: false,
				sourceType: "webMP4",
				eligibleLegacy: false,
			}).player,
		).toBe("legacy");
	});
});

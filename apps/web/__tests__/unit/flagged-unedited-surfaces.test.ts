import { Effect, Exit } from "effect";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const keys = vi.hoisted(() => ({
	outputKey: "owner-flagged/video/.recording/outputs/generation/attempt.mp4",
	screenshotKey: "owner-flagged/video/screenshot/screen-capture.jpg",
}));

const rows = vi.hoisted(() => ({
	intent: [] as unknown[],
	edits: [] as unknown[],
	metadata: null as unknown,
	source: [] as unknown[],
	video: {
		id: "video",
		ownerId: "owner-flagged",
		name: "Clip",
		public: true,
		password: null,
		duration: 4,
		isScreenshot: true,
		metadata: null,
		bucket: null,
		source: {
			type: "webMP4" as const,
			outputKey: keys.outputKey,
		},
	},
}));

const mocks = vi.hoisted(() => ({
	revisionArtifactUrl: vi.fn(async () => null as string | null),
	sign: vi.fn((key: string) => Effect.succeed(`https://media.example/${key}`)),
	policy: vi.fn(),
	render: vi.fn(async (input: unknown) => input),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "owner-flagged" }),
}));
vi.mock("@cap/database", async () => {
	const schema = await import("@cap/database/schema");
	const answer = (table: unknown) => {
		if (table === schema.editIntent) return rows.intent;
		if (table === schema.videoEdits) return rows.edits;
		if (table === schema.sourceObject) return rows.source;
		if (table === schema.videos) return [rows.video];
		return [];
	};
	return {
		db: () => ({
			select: (shape?: { video?: unknown }) => {
				const selected = shape?.video
					? [
							{
								video: rows.video,
								ownerName: "Brooks",
								currentDuration: 4,
							},
						]
					: answer(schema.videos);
				return {
					from: (table: unknown) => ({
						where: () => {
							const value = answer(table);
							const result = Promise.resolve(
								table === schema.videos && shape?.video ? selected : value,
							);
							return Object.assign(result, {
								limit: () => result,
							});
						},
						leftJoin: () => ({
							where: () => Promise.resolve(selected),
						}),
					}),
				};
			},
		}),
	};
});
vi.mock("@/lib/revision-media-grant", () => ({
	revisionArtifactUrl: mocks.revisionArtifactUrl,
	ownerOriginalPath: (id: string) => `/api/media/original?videoId=${id}`,
	mintRevisionMediaGrant: async () => null,
}));
vi.mock("@/lib/revision-publication-read", () => ({
	getInstantFinishPublicationDto: async () => ({
		enabled: true,
		currentRevisionId: null,
		generation: 0,
		duration: null,
		draftVersion: 0,
		draftSession: "",
		revisionMetadata: null,
	}),
	disabledInstantFinishPublication: () => ({
		enabled: false,
		currentRevisionId: null,
		generation: 0,
	}),
}));
vi.mock("@/lib/server", async () => ({
	runPromise: (await import("effect")).Effect.runPromise,
	runPromiseExit: mocks.policy,
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/video-download-permissions", () => ({
	canUserDownloadVideo: async () => true,
}));
vi.mock("@/utils/helpers", () => ({ getHeaders: () => ({}) }));
vi.mock("@/lib/og/video-og", () => ({
	renderVideoOg: mocks.render,
}));
vi.mock("@/lib/og/poster-frame", () => ({
	extractPosterFrameDataUri: async () => undefined,
}));
vi.mock("@cap/web-backend", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					listObjects: () =>
						Effect.succeed({
							Contents: [{ Key: keys.screenshotKey }],
						}),
					getSignedObjectUrl: (key: string) => {
						const resolved = key.endsWith("/result.mp4") ? keys.outputKey : key;
						return mocks.sign(resolved);
					},
					headObject: () => Effect.succeed({ ContentLength: 10 }),
				},
			]),
	},
	VideosPolicy: {},
	provideOptionalAuth: (value: unknown) => value,
	findScreenshotObjectKey: (objects: { Key?: string }[]) =>
		objects.find((object) => object.Key?.endsWith("screen-capture.jpg"))?.Key ??
		null,
}));

const outputKey = keys.outputKey;
const screenshotKey = keys.screenshotKey;

import { Video } from "@cap/web-domain";
import { getVideoDownloadInfo } from "@/actions/videos/download";
import { generateVideoOgImage } from "@/actions/videos/get-og-image";
import { GET as getThumbnail } from "@/app/api/thumbnail/route";
import { loadRevisionPlayback } from "@/lib/revision-playback-load";
import { getShareVideoUrls } from "@/lib/share-video-metadata";

describe("eligible legacy share surfaces", () => {
	afterEach(() => {
		delete process.env.CAP_INSTANT_FINISH_OWNERS;
		rows.intent = [];
		rows.edits = [];
		rows.source = [];
		rows.metadata = null;
		rows.video.metadata = null;
		rows.video.isScreenshot = true;
		mocks.revisionArtifactUrl.mockClear();
		mocks.sign.mockClear();
	});

	it("resolves a flagged screenshot thumbnail and OG frame from the public screenshot", async () => {
		process.env.CAP_INSTANT_FINISH_OWNERS = "owner-flagged";
		mocks.policy.mockResolvedValue(
			Exit.succeed([
				{
					id: "video",
					ownerId: "owner-flagged",
					source: { type: "webMP4" },
				},
			]),
		);
		const thumbnail = await getThumbnail(
			new NextRequest("https://cap.test/api/thumbnail?videoId=video"),
		);
		expect(thumbnail.status).toBe(200);
		expect(await thumbnail.json()).toEqual({
			screen: `https://media.example/${screenshotKey}`,
		});
		expect(mocks.revisionArtifactUrl).not.toHaveBeenCalled();

		const rendered = await generateVideoOgImage(Video.VideoId.make("video"));
		expect(rendered).toMatchObject({
			kind: "video",
			video: {
				screenshotUrl: `https://media.example/${screenshotKey}`,
			},
		});
		expect(JSON.stringify(rendered)).not.toContain("data:image/jpeg;base64");
	});

	it("signs the resolved output for an eligible MP4 and keeps a committed intent preparing", async () => {
		process.env.CAP_INSTANT_FINISH_OWNERS = "owner-flagged";
		rows.video.isScreenshot = false;
		const ready = await getVideoDownloadInfo(Video.VideoId.make("video"));
		expect(ready).toEqual({
			success: true,
			downloadUrl: `https://media.example/${outputKey}`,
			filename: "Clip.mp4",
		});

		rows.intent = [{ videoId: "video" }];
		const preparing = await getVideoDownloadInfo(Video.VideoId.make("video"));
		expect(preparing).toEqual({
			success: false,
			error: "Preparing download...",
		});
	});

	it("advertises the legacy stream for an eligible video and hides it after an intent or relocation", async () => {
		process.env.CAP_INSTANT_FINISH_OWNERS = "owner-flagged";
		const eligible = await loadRevisionPlayback({
			videoId: "video",
			ownerId: "owner-flagged",
			origin: "https://cap.test",
			isScreenshot: false,
			hasActiveUpload: false,
			sourceType: "webMP4",
		});
		const eligibleUrls = getShareVideoUrls({
			videoId: "video",
			sourceType: "webMP4",
			webUrl: "https://cap.test",
			revisionUnavailable: eligible.plan.player === "unavailable",
			revisionStreamUrl: eligible.publicPlaylistUrl ?? undefined,
			revisionThumbnailUnavailable: eligible.thumbnailUnavailable,
		});
		expect(eligibleUrls.streamUrl).toBe(
			"https://cap.test/api/playlist?videoId=video&videoType=mp4",
		);

		rows.intent = [{ videoId: "video" }];
		const intent = await loadRevisionPlayback({
			videoId: "video",
			ownerId: "owner-flagged",
			origin: "https://cap.test",
			isScreenshot: false,
			hasActiveUpload: false,
			sourceType: "webMP4",
		});
		const hidden = getShareVideoUrls({
			videoId: "video",
			sourceType: "webMP4",
			webUrl: "https://cap.test",
			revisionUnavailable: intent.plan.player === "unavailable",
		});
		expect(hidden.streamUrl).toBeNull();

		rows.intent = [];
		rows.source = [
			{
				relocationState: "PURGED",
				liveKey: "private/source/video/opaque",
			},
		];
		const relocated = await loadRevisionPlayback({
			videoId: "video",
			ownerId: "owner-flagged",
			origin: "https://cap.test",
			isScreenshot: false,
			hasActiveUpload: false,
			sourceType: "webMP4",
		});
		expect(
			getShareVideoUrls({
				videoId: "video",
				sourceType: "webMP4",
				webUrl: "https://cap.test",
				revisionUnavailable: relocated.plan.player === "unavailable",
			}).streamUrl,
		).toBeNull();
	});
});

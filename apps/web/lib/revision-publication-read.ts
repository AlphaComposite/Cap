import { db } from "@cap/database";
import {
	comments,
	editRevision,
	sourceObject,
	videoPublication,
	videos,
} from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import { ownerOriginalPath } from "@/lib/revision-media-grant";
import { pageMetadataForRevision } from "@/lib/revision-metadata-snapshot";
import { RevisionPublicationError } from "@/lib/revision-publication-metadata";
import { prepareSourceOnEditorOpen } from "@/lib/revision-publication-origin";
import { getEditSourceKey } from "@/lib/video-edit-processing";

type Database = ReturnType<typeof db>;

export type PublicationProjection = {
	videoId: string;
	currentRevisionId: string | null;
	generation: number;
	currentGeneration: number | null;
	publicationEpoch: number;
	policyEpoch: number;
	latestDraftVersion: number;
	draftSession: string;
};

export type InstantFinishPublicationDto = {
	enabled: boolean;
	currentRevisionId: string | null;
	generation: number;
	duration: number | null;
	draftVersion: number;
	draftSession: string;
	revisionMetadata: {
		duration: number | null;
		chapters: { title: string; start: number }[];
		captionsAvailable: boolean;
		commentTimestamps: Record<string, number | null>;
		thumbnailAvailable: boolean;
		downloadReady: boolean;
		playlistPath: string | null;
		summaryStatus: "persisted";
		summaryDerived: false;
		summaryText: string | null;
		captions: "revision" | "unavailable";
		chaptersStatus: "revision" | "unavailable";
		thumbnail: "source-zero" | "seg0-first-frame" | "unavailable";
		download: "preparing" | "unavailable";
		commentClock: "output-time";
		removedRangeComments: "hidden";
	};
};

export function disabledInstantFinishPublication(
	overrides: Partial<InstantFinishPublicationDto> = {},
): InstantFinishPublicationDto {
	return {
		enabled: false,
		currentRevisionId: null,
		generation: 0,
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
			summaryStatus: "persisted",
			summaryDerived: false,
			summaryText: null,
			captions: "unavailable",
			chaptersStatus: "unavailable",
			thumbnail: "unavailable",
			download: "unavailable",
			commentClock: "output-time",
			removedRangeComments: "hidden",
		},
		...overrides,
	};
}

function asVideoId(value: string): Video.VideoId {
	return value as Video.VideoId;
}

function isDrizzleColumn(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"table" in value &&
		"name" in value
	);
}

export async function resolveRollbackSourceKey(
	videoId: string,
	recordedSourceKey: string,
	database: unknown = db(),
): Promise<string> {
	const app = database as Database;
	if (!isDrizzleColumn(sourceObject?.liveKey)) return recordedSourceKey;
	const [row] = await app
		.select({ liveKey: sourceObject.liveKey })
		.from(sourceObject)
		.where(eq(sourceObject.videoId, asVideoId(videoId)));
	if (!row?.liveKey) return recordedSourceKey;
	if (row.liveKey.endsWith("/result.mp4")) return recordedSourceKey;
	return row.liveKey;
}

export async function readPublicationProjection(
	videoId: string,
	database: unknown = db(),
): Promise<PublicationProjection | null> {
	const app = database as Database;
	const [row] = await app
		.select()
		.from(videoPublication)
		.where(eq(videoPublication.videoId, asVideoId(videoId)));
	if (!row) return null;
	return {
		videoId: row.videoId,
		currentRevisionId: row.currentRevisionId,
		generation: row.generation,
		currentGeneration: row.currentGeneration,
		publicationEpoch: row.publicationEpoch,
		policyEpoch: row.policyEpoch,
		latestDraftVersion: row.latestDraftVersion,
		draftSession: row.draftSession,
	};
}

export async function readPublicationEpoch(
	videoId: string,
	database: unknown = db(),
): Promise<number> {
	const row = await readPublicationProjection(videoId, database);
	return row?.policyEpoch ?? 0;
}

export async function getInstantFinishPublicationDto(input: {
	videoId: string;
	ownerId: string;
	summaryText?: string | null;
	durationFallback?: number | null;
	database?: unknown;
}): Promise<InstantFinishPublicationDto> {
	const database = (input.database ?? db()) as Database;
	const enabled = isInstantFinishEnabledForOwner(input.ownerId);
	const projection = await readPublicationProjection(input.videoId, database);
	if (!enabled || !projection?.currentRevisionId) {
		return disabledInstantFinishPublication({
			enabled,
			generation: projection?.generation ?? 0,
			duration: input.durationFallback ?? null,
			draftVersion: projection?.latestDraftVersion ?? 0,
			draftSession: projection?.draftSession ?? "",
			revisionMetadata: {
				...disabledInstantFinishPublication().revisionMetadata,
				summaryText: input.summaryText ?? null,
			},
		});
	}
	const [revision] = await database
		.select()
		.from(editRevision)
		.where(eq(editRevision.revisionId, projection.currentRevisionId));
	const snapshot = revision?.metadataSnapshot ?? null;
	const page = pageMetadataForRevision({
		snapshot,
		liveMetadata: null,
	});
	const duration = page.durationSeconds ?? input.durationFallback ?? null;
	const commentRows = await database
		.select({ id: comments.id, timestamp: comments.timestamp })
		.from(comments)
		.where(eq(comments.videoId, asVideoId(input.videoId)));
	const commentTimestamps = Object.fromEntries(
		commentRows.map((row) => [row.id, row.timestamp]),
	);
	return {
		enabled: true,
		currentRevisionId: projection.currentRevisionId,
		generation: projection.currentGeneration ?? projection.generation,
		duration,
		draftVersion: projection.latestDraftVersion,
		draftSession: projection.draftSession,
		revisionMetadata: {
			duration,
			chapters: page.chapters,
			captionsAvailable: page.captionsVtt != null,
			commentTimestamps,
			thumbnailAvailable: page.thumbnail !== "unavailable",
			downloadReady: false,
			playlistPath: `/media/${input.videoId}/r/${projection.currentRevisionId}/playlist.m3u8`,
			summaryStatus: "persisted",
			summaryDerived: false,
			summaryText: page.summaryText,
			captions: page.captionsVtt != null ? "revision" : "unavailable",
			chaptersStatus: snapshot ? "revision" : "unavailable",
			thumbnail: page.thumbnail,
			download: "preparing",
			commentClock: "output-time",
			removedRangeComments: "hidden",
		},
	};
}

export function selectEditorPlayback(input: {
	flagged: boolean;
	existingEdit: boolean;
	ownerProxyUrl: string | null;
	presignedOriginalUrl: string | null;
	playlistUrl: string;
}): { playbackSrc: string; usesOriginalSource: boolean; usedPresign: boolean } {
	if (input.flagged) {
		if (!input.ownerProxyUrl) {
			throw new RevisionPublicationError(
				500,
				"Owner original proxy is unavailable",
			);
		}
		return {
			playbackSrc: input.ownerProxyUrl,
			usesOriginalSource: true,
			usedPresign: false,
		};
	}
	if (input.existingEdit) {
		if (!input.presignedOriginalUrl) {
			throw new RevisionPublicationError(
				500,
				"The original recording is unavailable, so this edit cannot be opened safely.",
			);
		}
		return {
			playbackSrc: input.presignedOriginalUrl,
			usesOriginalSource: true,
			usedPresign: true,
		};
	}
	return {
		playbackSrc: input.playlistUrl,
		usesOriginalSource: false,
		usedPresign: false,
	};
}

export async function openInstantFinishEditor(
	videoId: string,
	database: unknown = db(),
): Promise<{ playbackSrc: string; draftSession: string; generation: number }> {
	const app = database as Database;
	const [video] = await app
		.select({ ownerId: videos.ownerId })
		.from(videos)
		.where(eq(videos.id, asVideoId(videoId)));
	if (!video) {
		throw new RevisionPublicationError(404, "Video not found");
	}
	const sourceKey = await resolveRollbackSourceKey(
		videoId,
		getEditSourceKey(video.ownerId, videoId),
		app,
	);
	const prepared = await prepareSourceOnEditorOpen({ videoId, sourceKey });
	const warmExpiresAt = new Date(prepared.warmExpiresAt);
	if (
		Number.isNaN(warmExpiresAt.getTime()) ||
		warmExpiresAt.getTime() <= Date.now()
	) {
		throw new RevisionPublicationError(
			409,
			"Editor-open warm expiry is not in the future",
		);
	}
	const [existing] = await app
		.select()
		.from(sourceObject)
		.where(eq(sourceObject.videoId, asVideoId(videoId)));
	if (existing && existing.sha256 !== prepared.sha256) {
		throw new RevisionPublicationError(
			409,
			"Source identity changed after it was recorded",
		);
	}
	if (!existing) {
		await app.insert(sourceObject).values({
			videoId: asVideoId(videoId),
			liveKey: prepared.sourceKey,
			sha256: prepared.sha256,
			relocationState: "LIVE",
			codec: prepared.codec,
			timebase: prepared.timebase,
			frameMode: prepared.frameMode,
			a1Digest: prepared.a1Digest,
			indexId: prepared.indexId,
			warmExpiresAt,
		});
	} else if (existing.relocationState === "LIVE") {
		await app
			.update(sourceObject)
			.set({
				liveKey: prepared.sourceKey,
				codec: prepared.codec,
				timebase: prepared.timebase,
				frameMode: prepared.frameMode,
				a1Digest: prepared.a1Digest,
				indexId: prepared.indexId,
				warmExpiresAt,
			})
			.where(eq(sourceObject.videoId, asVideoId(videoId)));
	} else {
		await app
			.update(sourceObject)
			.set({
				codec: prepared.codec,
				timebase: prepared.timebase,
				frameMode: prepared.frameMode,
				a1Digest: prepared.a1Digest,
				indexId: prepared.indexId,
				warmExpiresAt,
			})
			.where(eq(sourceObject.videoId, asVideoId(videoId)));
	}
	await app
		.insert(videoPublication)
		.values({ videoId: asVideoId(videoId) })
		.onDuplicateKeyUpdate({ set: { videoId: asVideoId(videoId) } });
	const [publication] = await app
		.select()
		.from(videoPublication)
		.where(eq(videoPublication.videoId, asVideoId(videoId)));
	const playbackSrc = ownerOriginalPath(videoId);
	if (playbackSrc.includes("X-Amz-") || playbackSrc.includes("amazonaws")) {
		throw new RevisionPublicationError(
			500,
			"Editor open must not mint an S3 presign",
		);
	}
	return {
		playbackSrc,
		draftSession: publication?.draftSession ?? "",
		generation: publication?.generation ?? 0,
	};
}

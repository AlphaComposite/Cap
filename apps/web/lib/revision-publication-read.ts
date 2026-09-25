import { db } from "@cap/database";
import {
	editIntent,
	editRevision,
	sourceObject,
	videoPublication,
	videos,
} from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import { ownerOriginalPath } from "@/lib/revision-media-grant";
import {
	deriveRevisionChapters,
	previousEditionSpec,
	RevisionPublicationError,
} from "@/lib/revision-publication-metadata";
import { prepareSourceOnEditorOpen } from "@/lib/revision-publication-origin";
import { getEditSpecOutputDuration } from "@/lib/video-edits";

type Database = ReturnType<typeof db>;

export type PublicationProjection = {
	videoId: string;
	currentRevisionId: string | null;
	generation: number;
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
	revisionMetadata: {
		playlistPath: string | null;
		summaryStatus: "persisted";
		summaryDerived: false;
		summaryText: string | null;
		captions: "revision" | "unavailable";
		chapters: { title: string; start: number }[];
		chaptersStatus: "revision" | "unavailable";
		thumbnail: "source-zero" | "seg0-first-frame" | "unavailable";
		download: "preparing" | "unavailable";
		commentClock: "output-time";
		removedRangeComments: "hidden";
	};
};

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
		publicationEpoch: row.publicationEpoch,
		policyEpoch: row.policyEpoch,
		latestDraftVersion: row.latestDraftVersion,
		draftSession: row.draftSession,
	};
}

export async function bumpPublicationPolicyEpoch(
	videoId: string,
	database: unknown = db(),
): Promise<number> {
	const app = database as Database;
	return app.transaction(async (tx) => {
		await tx
			.insert(videoPublication)
			.values({ videoId: asVideoId(videoId) })
			.onDuplicateKeyUpdate({ set: { videoId: asVideoId(videoId) } });
		const [row] = await tx
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, asVideoId(videoId)))
			.for("update");
		if (!row) {
			throw new RevisionPublicationError(
				500,
				"Publication row was not created",
			);
		}
		const next = row.policyEpoch + 1;
		await tx
			.update(videoPublication)
			.set({ policyEpoch: next })
			.where(eq(videoPublication.videoId, asVideoId(videoId)));
		return next;
	});
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
		return {
			enabled,
			currentRevisionId: null,
			generation: projection?.generation ?? 0,
			duration: input.durationFallback ?? null,
			revisionMetadata: {
				playlistPath: null,
				summaryStatus: "persisted",
				summaryDerived: false,
				summaryText: input.summaryText ?? null,
				captions: "unavailable",
				chapters: [],
				chaptersStatus: "unavailable",
				thumbnail: "unavailable",
				download: "unavailable",
				commentClock: "output-time",
				removedRangeComments: "hidden",
			},
		};
	}
	const [revision] = await database
		.select()
		.from(editRevision)
		.where(eq(editRevision.revisionId, projection.currentRevisionId));
	const [intent] = revision
		? await database
				.select({ canonicalSpec: editIntent.canonicalSpec })
				.from(editIntent)
				.where(
					sql`${editIntent.videoId} = ${input.videoId} and ${editIntent.generation} = ${revision.generation}`,
				)
		: [];
	const spec = intent?.canonicalSpec;
	const duration = spec
		? getEditSpecOutputDuration(spec)
		: (input.durationFallback ?? null);
	const [video] = await database
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, asVideoId(input.videoId)));
	const storedChapters = video?.metadata?.chapters ?? [];
	const nextSpec = spec?.version === 2 ? spec : null;
	const chapters = nextSpec
		? deriveRevisionChapters({
				storedChapters,
				previousSpec: previousEditionSpec({
					currentSpec: nextSpec,
					rollbackSpec: null,
					sourceDuration: nextSpec.sourceDuration,
				}),
				nextSpec,
			})
		: [];
	const thumbnail =
		nextSpec && nextSpec.keepRanges[0]?.start === 0
			? "source-zero"
			: nextSpec
				? "seg0-first-frame"
				: "unavailable";
	return {
		enabled: true,
		currentRevisionId: projection.currentRevisionId,
		generation: projection.generation,
		duration,
		revisionMetadata: {
			playlistPath: `/media/${input.videoId}/r/${projection.currentRevisionId}/playlist.m3u8`,
			summaryStatus: "persisted",
			summaryDerived: false,
			summaryText: input.summaryText ?? video?.metadata?.summary ?? null,
			captions: "revision",
			chapters: nextSpec ? chapters : [],
			chaptersStatus: nextSpec ? "revision" : "unavailable",
			thumbnail,
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
	const prepared = await prepareSourceOnEditorOpen(videoId);
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

import { db } from "@cap/database";
import {
	comments,
	editRevision,
	revisionOutbox,
	sourceObject,
	sourceRelocation,
	videoPublication,
	videos,
} from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { editorOpenable } from "@/lib/editor-openable";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import { relocateFlaggedSource } from "@/lib/instant-finish-source-relocate";
import { ownerOriginalPath } from "@/lib/revision-media-grant";
import {
	pageMetadataForRevision,
	resolveRevisionChapters,
} from "@/lib/revision-metadata-snapshot";
import { RevisionPublicationError } from "@/lib/revision-publication-metadata";
import { prepareSourceOnEditorOpen } from "@/lib/revision-publication-origin";
import { warmSourceFromRow } from "@/lib/revision-source-warm";
import {
	captionsHaveCues,
	editorJoinPlan,
	SOURCE_PREPARE_JOB,
} from "@/lib/source-prepare";
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
	const [videoRow] = await database
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, asVideoId(input.videoId)));
	page.chapters = resolveRevisionChapters({
		currentRevisionId: projection.currentRevisionId,
		snapshotChapters: page.chapters,
		liveChapters: videoRow?.metadata?.chapters,
		liveChaptersRevisionId: videoRow?.metadata?.chaptersRevisionId,
	});
	page.summaryText =
		videoRow?.metadata && Object.hasOwn(videoRow.metadata, "summary")
			? (videoRow.metadata.summary ?? null)
			: page.summaryText;
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
		generation: projection.generation,
		duration,
		draftVersion: projection.latestDraftVersion,
		draftSession: projection.draftSession,
		revisionMetadata: {
			duration,
			chapters: page.chapters,
			captionsAvailable: captionsHaveCues(page.captionsVtt ?? ""),
			commentTimestamps,
			thumbnailAvailable: page.thumbnail !== "unavailable",
			downloadReady: revision?.metadataSnapshot?.downloadReady === true,
			playlistPath: `/media/${input.videoId}/r/${projection.currentRevisionId}/playlist.m3u8`,
			summaryStatus: "persisted",
			summaryDerived: false,
			summaryText: page.summaryText,
			captions: captionsHaveCues(page.captionsVtt ?? "")
				? "revision"
				: "unavailable",
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

async function requestIsActionRefresh(): Promise<boolean> {
	try {
		const { headers } = await import("next/headers");
		return Boolean((await headers()).get("next-action"));
	} catch {
		return false;
	}
}

export async function openInstantFinishEditor(
	videoId: string,
	database: unknown = db(),
	options?: {
		actionRefresh?: boolean;
		now?: Date;
		prepare?: typeof prepareSourceOnEditorOpen;
		relocate?: typeof relocateFlaggedSource;
		stageWaitMs?: number;
	},
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
	const now = options?.now ?? new Date();
	const actionRefresh =
		options?.actionRefresh ?? (await requestIsActionRefresh());
	const [existingBeforePrepare] = await app
		.select()
		.from(sourceObject)
		.where(eq(sourceObject.videoId, asVideoId(videoId)));
	const alreadyPurged =
		existingBeforePrepare?.relocationState === "PURGED" &&
		editorOpenable({
			videoId,
			source: existingBeforePrepare,
			relocations: [],
			pending: false,
			now,
		});
	const pending = await openSourcePrepare(app, videoId);
	if (pending && !pending.exhausted && !alreadyPurged) {
		const joined = await waitForJoinedStage(
			app,
			videoId,
			now,
			options?.stageWaitMs ?? 5_000,
		);
		if (!joined) {
			throw new RevisionPublicationError(
				409,
				"Registered source is not ready; retry",
			);
		}
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
	const join = editorJoinPlan({
		pending: pending != null,
		exhausted: pending?.exhausted === true,
		registeredPrivateKey: alreadyPurged
			? (existingBeforePrepare?.liveKey ?? null)
			: null,
		videoId,
	});
	const relocated = alreadyPurged
		? {
				liveKey: existingBeforePrepare?.liveKey ?? "",
				sha256: existingBeforePrepare?.sha256 ?? "",
			}
		: join.relocate === false
			? {
					liveKey: join.sourceKey,
					sha256: existingBeforePrepare?.sha256 ?? "",
				}
			: await (options?.relocate ?? relocateFlaggedSource)({
					videoId,
					ownerId: video.ownerId,
					sourceKey,
					database: app,
				});
	const warm =
		(actionRefresh || (pending != null && !pending.exhausted)) && alreadyPurged
			? warmSourceFromRow(existingBeforePrepare ?? null, now)
			: null;
	const preparedSource =
		warm ??
		(await (options?.prepare ?? prepareSourceOnEditorOpen)({
			videoId,
			sourceKey: relocated.liveKey,
		}));
	const prepared = {
		...preparedSource,
		sourceKey: relocated.liveKey,
		sha256: relocated.sha256,
	};
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
	if (existing?.sha256 && existing.sha256 !== prepared.sha256) {
		throw new RevisionPublicationError(
			409,
			"Source identity changed after it was recorded",
		);
	}
	if (join.relocate === false) {
		if (existing && existing.relocationState !== "LIVE") {
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
	} else if (!existing) {
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

async function waitForJoinedStage(
	app: Database,
	videoId: string,
	now: Date,
	waitMs: number,
) {
	const deadline = Date.now() + waitMs;
	for (;;) {
		const joined = await readJoinedStage(app, videoId, now);
		if (joined || Date.now() >= deadline) return joined;
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now()))),
		);
	}
}

async function readJoinedStage(app: Database, videoId: string, now: Date) {
	const preparation = await readEditorPreparation(app, videoId, now);
	return preparation.editorOpenable ? preparation : null;
}

export async function readEditorPreparation(
	app: Database,
	videoId: string,
	now = new Date(),
) {
	try {
		const [source] = await app
			.select()
			.from(sourceObject)
			.where(eq(sourceObject.videoId, asVideoId(videoId)));
		const relocations = await app
			.select()
			.from(sourceRelocation)
			.where(eq(sourceRelocation.videoId, asVideoId(videoId)));
		const rows = await app
			.select()
			.from(revisionOutbox)
			.where(eq(revisionOutbox.videoId, asVideoId(videoId)));
		const pending = rows.find(
			(row) => row.job === SOURCE_PREPARE_JOB && row.payload?.finished !== true,
		);
		const openable = editorOpenable({
			videoId,
			source: source ?? null,
			relocations,
			pending: Boolean(pending && pending.payload?.exhausted !== true),
			now,
		});
		const sourcePrepare =
			pending?.payload?.exhausted === true
				? ("failed" as const)
				: !pending && openable
					? ("done" as const)
					: pending &&
							(Number(pending.payload?.attempts) > 0 ||
								pending.payload?.phase !== "queued")
						? ("running" as const)
						: ("queued" as const);
		return {
			editorOpenable: openable,
			sourcePrepare,
			reason:
				sourcePrepare === "failed"
					? String(pending?.payload?.error ?? "Preparing for editing failed")
					: undefined,
			identity: { source, relocations, pending, editorOpenable: openable },
		};
	} catch {
		return {
			editorOpenable: false,
			sourcePrepare: "failed" as const,
			reason: "Unable to check preparation for editing",
			identity: null,
		};
	}
}

async function openSourcePrepare(
	app: Database,
	videoId: string,
): Promise<{ exhausted: boolean } | null> {
	try {
		const rows = (await app
			.select()
			.from(revisionOutbox)
			.where(eq(revisionOutbox.videoId, asVideoId(videoId)))) as Array<{
			job?: string;
			payload?: { finished?: boolean; exhausted?: boolean };
		}>;
		const open = rows.find(
			(row) => row.job === SOURCE_PREPARE_JOB && row.payload?.finished !== true,
		);
		if (!open) return null;
		return { exhausted: open.payload?.exhausted === true };
	} catch {
		throw new RevisionPublicationError(
			409,
			"Source prepare status could not be read; retry",
		);
	}
}

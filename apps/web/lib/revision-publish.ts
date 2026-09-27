import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { VideoEditSpec } from "@cap/database/types";
import { userIsPro } from "@cap/utils";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { EditTranscript } from "@/lib/edit-transcript";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import { mintRevisionMediaGrant } from "@/lib/revision-media-grant";
import {
	prepareInstantFinishRevision,
	publishInstantFinishRevision,
	RevisionPublicationError,
	recordServerDraft,
} from "@/lib/revision-publication";
import { httpOriginClient } from "@/lib/revision-publication-origin";
import type { InstantFinishPublicationDto } from "@/lib/revision-publication-read";
import { getInstantFinishPublicationDto } from "@/lib/revision-publication-read";
import { resolveShareWebUrl } from "@/lib/share-web-url";
import type { VideoChapter } from "@/lib/video-edits";

export type PublishVideoRevisionInput = {
	videoId: Video.VideoId;
	editSpec: VideoEditSpec;
	expectedEditSpec?: VideoEditSpec;
	baseGeneration: number;
	draftVersion: number;
	draftSession: string;
	chapters?: VideoChapter[];
	transcript?: EditTranscript | null;
};

export async function loadOwnerVideo(videoId: Video.VideoId) {
	const user = await getCurrentUser();
	if (!user) throw new RevisionPublicationError(401, "Unauthorized");
	if (!userIsPro(user)) {
		throw new RevisionPublicationError(
			403,
			"Cap Pro is required to edit videos",
		);
	}
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));
	if (!video) throw new RevisionPublicationError(404, "Video not found");
	if (video.ownerId !== user.id) {
		throw new RevisionPublicationError(403, "Forbidden");
	}
	if (video.isScreenshot) {
		throw new RevisionPublicationError(400, "Screenshots cannot be edited");
	}
	if (video.source.type !== "desktopMP4" && video.source.type !== "webMP4") {
		throw new RevisionPublicationError(
			400,
			"Only processed MP4 videos can be edited",
		);
	}
	return { user, video };
}

function assertDefaultCapBucket(video: {
	bucket: string | null;
	storageIntegrationId: string | null;
}) {
	if (video.bucket != null || video.storageIntegrationId != null) {
		throw new RevisionPublicationError(
			409,
			"Instant finish requires the default cap bucket",
		);
	}
}

export type PublishPlaybackPayload = {
	playlistUrl: string;
	grantExpiresAt: number;
	revisionMetadata: InstantFinishPublicationDto["revisionMetadata"];
};

async function loadPublishPlayback(
	input: {
		videoId: string;
		ownerId: string;
		revisionId: string;
	},
	headerList: Headers,
): Promise<PublishPlaybackPayload | null> {
	try {
		const origin = await resolveShareWebUrl(headerList);
		const publication = await getInstantFinishPublicationDto({
			videoId: input.videoId,
			ownerId: input.ownerId,
		});
		if (publication.currentRevisionId !== input.revisionId) return null;
		const grant = await mintRevisionMediaGrant(null, input.videoId, { origin });
		if (!grant || !("ok" in grant) || !grant.ok) return null;
		if (grant.revisionId !== input.revisionId) return null;
		return {
			playlistUrl: grant.playbackUrl,
			grantExpiresAt: grant.expiresAt,
			revisionMetadata: publication.revisionMetadata,
		};
	} catch {
		return null;
	}
}

function recordedInput(
	input: PublishVideoRevisionInput,
	recorded: {
		generation: number;
		draftVersion: number;
		draftSession: string;
	},
	video: {
		metadata?: { chapters?: VideoChapter[] } | null;
		duration: number | null;
	},
) {
	return {
		videoId: input.videoId,
		editSpec: input.editSpec,
		expectedEditSpec: input.expectedEditSpec,
		baseGeneration: recorded.generation,
		draftVersion: recorded.draftVersion,
		draftSession: recorded.draftSession,
		chapters: input.chapters ?? video.metadata?.chapters ?? [],
		transcript: input.transcript ?? null,
		sourceDuration: video.duration,
	};
}

export async function prepareOwnerRevision(
	input: PublishVideoRevisionInput,
	options?: { signal?: AbortSignal },
) {
	const { video } = await loadOwnerVideo(input.videoId);
	if (!isInstantFinishEnabledForOwner(video.ownerId)) {
		throw new RevisionPublicationError(
			403,
			"Instant finish is not enabled for this video",
		);
	}
	assertDefaultCapBucket(video);
	const recorded = await recordServerDraft(db(), {
		videoId: input.videoId,
		draftVersion: input.draftVersion,
		draftSession: input.draftSession,
	});
	return prepareInstantFinishRevision(
		db(),
		recordedInput(input, recorded, video),
		{ origin: httpOriginClient(options?.signal) },
	);
}

export async function publishOwnerRevision(
	input: PublishVideoRevisionInput,
	headerList: Headers,
) {
	const { video } = await loadOwnerVideo(input.videoId);
	if (!isInstantFinishEnabledForOwner(video.ownerId)) {
		throw new RevisionPublicationError(
			403,
			"Instant finish is not enabled for this video",
		);
	}
	assertDefaultCapBucket(video);
	const recorded = await recordServerDraft(db(), {
		videoId: input.videoId,
		draftVersion: input.draftVersion,
		draftSession: input.draftSession,
	});
	const published = await publishInstantFinishRevision(
		db(),
		recordedInput(input, recorded, video),
		{ origin: httpOriginClient() },
	);
	revalidatePath(`/s/${input.videoId}`);
	const playback = await loadPublishPlayback(
		{
			videoId: input.videoId,
			ownerId: video.ownerId,
			revisionId: published.revisionId,
		},
		headerList,
	);
	return { ...published, playback };
}

export function parseRevisionRouteBody(
	body: unknown,
): PublishVideoRevisionInput | null {
	if (!body || typeof body !== "object") return null;
	const record = body as Record<string, unknown>;
	if (typeof record.videoId !== "string") return null;
	if (!record.editSpec || typeof record.editSpec !== "object") return null;
	if (typeof record.baseGeneration !== "number") return null;
	if (typeof record.draftVersion !== "number") return null;
	if (typeof record.draftSession !== "string") return null;
	return {
		videoId: record.videoId as Video.VideoId,
		editSpec: record.editSpec as VideoEditSpec,
		expectedEditSpec:
			record.expectedEditSpec && typeof record.expectedEditSpec === "object"
				? (record.expectedEditSpec as VideoEditSpec)
				: undefined,
		baseGeneration: record.baseGeneration,
		draftVersion: record.draftVersion,
		draftSession: record.draftSession,
	};
}

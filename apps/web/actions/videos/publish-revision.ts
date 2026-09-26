"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { VideoEditSpec } from "@cap/database/types";
import { userIsPro } from "@cap/utils";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import type { EditTranscript } from "@/lib/edit-transcript";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import { mintRevisionMediaGrant } from "@/lib/revision-media-grant";
import {
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

async function loadOwnerVideo(videoId: Video.VideoId) {
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
	if (video.ownerId !== user.id)
		throw new RevisionPublicationError(403, "Forbidden");
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

async function loadPublishPlayback(input: {
	videoId: string;
	ownerId: string;
	revisionId: string;
}): Promise<PublishPlaybackPayload | null> {
	try {
		const origin = await resolveShareWebUrl(await headers());
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

export async function publishVideoRevision(input: PublishVideoRevisionInput) {
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
		{
			videoId: input.videoId,
			editSpec: input.editSpec,
			expectedEditSpec: input.expectedEditSpec,
			baseGeneration: recorded.generation,
			draftVersion: recorded.draftVersion,
			draftSession: recorded.draftSession,
			chapters: input.chapters ?? video.metadata?.chapters ?? [],
			transcript: input.transcript ?? null,
			sourceDuration: video.duration,
		},
		{ origin: httpOriginClient() },
	);
	revalidatePath(`/s/${input.videoId}`);
	const playback = await loadPublishPlayback({
		videoId: input.videoId,
		ownerId: video.ownerId,
		revisionId: published.revisionId,
	});
	return { ...published, playback };
}

export async function getEditorInstantFinishState(input: {
	videoId: Video.VideoId;
	ownerId: string;
}) {
	const { getInstantFinishPublicationDto } = await import(
		"@/lib/revision-publication-read"
	);
	const publication = await getInstantFinishPublicationDto(input);
	return {
		enabled: publication.enabled,
		generation: publication.generation,
		draftVersion: publication.draftVersion,
		draftSession: publication.draftSession,
	};
}

export async function recordServerEditDraft(input: {
	videoId: Video.VideoId;
	draftVersion: number;
	draftSession: string;
}) {
	const { video } = await loadOwnerVideo(input.videoId);
	if (!isInstantFinishEnabledForOwner(video.ownerId)) {
		throw new RevisionPublicationError(
			403,
			"Instant finish is not enabled for this video",
		);
	}
	return recordServerDraft(db(), input);
}

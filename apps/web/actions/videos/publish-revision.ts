"use server";

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
import {
	publishInstantFinishRevision,
	RevisionPublicationError,
	recordServerDraft,
} from "@/lib/revision-publication";
import { httpOriginClient } from "@/lib/revision-publication-origin";
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

export async function publishVideoRevision(input: PublishVideoRevisionInput) {
	const { video } = await loadOwnerVideo(input.videoId);
	if (!isInstantFinishEnabledForOwner(video.ownerId)) {
		throw new RevisionPublicationError(
			403,
			"Instant finish is not enabled for this video",
		);
	}
	assertDefaultCapBucket(video);
	const published = await publishInstantFinishRevision(
		db(),
		{
			videoId: input.videoId,
			editSpec: input.editSpec,
			expectedEditSpec: input.expectedEditSpec,
			baseGeneration: input.baseGeneration,
			draftVersion: input.draftVersion,
			draftSession: input.draftSession,
			chapters: input.chapters ?? video.metadata?.chapters ?? [],
			transcript: input.transcript ?? null,
			sourceDuration: video.duration,
		},
		{ origin: httpOriginClient() },
	);
	revalidatePath(`/s/${input.videoId}`);
	revalidatePath(`/s/${input.videoId}/edit`);
	return published;
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

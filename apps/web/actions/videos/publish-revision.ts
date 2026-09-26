"use server";

import { db } from "@cap/database";
import type { Video } from "@cap/web-domain";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import {
	RevisionPublicationError,
	recordServerDraft,
} from "@/lib/revision-publication";
import { loadOwnerVideo } from "@/lib/revision-publish";

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

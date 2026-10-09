"use server";

import { db } from "@cap/database";
import { editIntent, editRevision } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import {
	RevisionPublicationError,
	recordServerDraft,
} from "@/lib/revision-publication";
import { loadOwnerVideo } from "@/lib/revision-publish";
import { parseRenderedCanonicalSpec } from "@/lib/video-edits";

export async function getEditorInstantFinishState(input: {
	videoId: Video.VideoId;
	ownerId: string;
}) {
	const { getInstantFinishPublicationDto } = await import(
		"@/lib/revision-publication-read"
	);
	const publication = await getInstantFinishPublicationDto(input);
	const [intent] = publication.currentRevisionId
		? await db()
				.select({ canonicalSpec: editIntent.canonicalSpec })
				.from(editIntent)
				.innerJoin(
					editRevision,
					and(
						eq(editRevision.videoId, editIntent.videoId),
						eq(editRevision.generation, editIntent.generation),
					),
				)
				.where(
					and(
						eq(editIntent.videoId, input.videoId),
						eq(editRevision.revisionId, publication.currentRevisionId),
					),
				)
		: [];
	return {
		enabled: publication.enabled,
		generation: publication.generation,
		draftVersion: publication.draftVersion,
		draftSession: publication.draftSession,
		expectedEditSpec: intent
			? parseRenderedCanonicalSpec(intent.canonicalSpec)
			: null,
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

export async function rewarmEditorSource(videoId: Video.VideoId) {
	try {
		const { video } = await loadOwnerVideo(videoId);
		if (!isInstantFinishEnabledForOwner(video.ownerId)) {
			throw new RevisionPublicationError(
				403,
				"Instant finish is not enabled for this video",
			);
		}
		const { openInstantFinishEditor } = await import(
			"@/lib/revision-publication-read"
		);
		await openInstantFinishEditor(videoId);
		return { success: true };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to prepare video for editing",
		};
	}
}

"use server";

// CONTRACT STUB (owned by W-A)
// Integrator replaces this action. It must return success only after CURRENT
// points at the new revision. This stub never reports a fake revision.

import type { VideoEditSpec } from "@cap/database/types";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import { getRevisionPublication } from "@/lib/revision-publication";

export type PublishRevisionInput = {
	videoId: string;
	ownerId: string;
	editSpec: VideoEditSpec;
	expectedEditSpec: VideoEditSpec;
	baseGeneration: number;
	draftVersion: number;
	draftSession: string;
};

export type PublishRevisionResult =
	| { success: true; revisionId: string; generation: number }
	| { success: false; status: 409; message: string }
	| { success: false; status: 503; message: string }
	| { success: false; reason: "flag-off" };

export async function getEditorInstantFinishState(input: {
	videoId: string;
	ownerId: string;
}): Promise<{ enabled: boolean; generation: number; draftVersion: number }> {
	const publication = await getRevisionPublication(input);
	return {
		enabled: publication.enabled,
		generation: publication.generation,
		draftVersion: publication.draftVersion,
	};
}

export async function publishRevision(
	input: PublishRevisionInput,
): Promise<PublishRevisionResult> {
	if (!isInstantFinishEnabledForOwner(input.ownerId)) {
		return { success: false, reason: "flag-off" };
	}
	if (
		!input.videoId ||
		!input.draftSession ||
		!Number.isFinite(input.baseGeneration) ||
		!Number.isFinite(input.draftVersion)
	) {
		return {
			success: false,
			status: 409,
			message: "A newer draft exists. Retry Done.",
		};
	}
	return {
		success: false,
		status: 503,
		message: "Revision publish is not available yet",
	};
}

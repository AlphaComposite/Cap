// CONTRACT STUB (owned by W-D)
// Integrator replaces mint, refresh, and the presign decision with
// VideosPolicy plus the current publication read. This stub never mints a
// bearer and never logs a URL.

import { isInstantFinishEnabledForOwner } from "./instant-finish-flag";

export type PlaylistPresignKind = "raw-or-segments" | "mp4";
export type PlaylistPresignDecision = "allow" | "not-found" | "gone";

export type RevisionMediaGrant = {
	grant: string;
	expiresAt: number;
};

export async function mintRevisionMediaGrant(_input: {
	videoId: string;
	revisionId: string;
}): Promise<RevisionMediaGrant | null> {
	return null;
}

export async function decidePlaylistPresign(input: {
	videoId: string;
	ownerId: string;
	kind: PlaylistPresignKind;
}): Promise<PlaylistPresignDecision> {
	const forced = process.env.CAP_INSTANT_FINISH_PLAYLIST_DENY;
	if (forced === "gone" || forced === "not-found") return forced;
	if (!isInstantFinishEnabledForOwner(input.ownerId)) return "allow";
	if (input.kind === "raw-or-segments" || input.kind === "mp4") {
		return "not-found";
	}
	return "allow";
}

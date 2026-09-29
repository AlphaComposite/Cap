import "server-only";

import { loadEligibleLegacy } from "./flagged-unedited";
import { isInstantFinishEnabledForOwner } from "./instant-finish-flag";
import { mintRevisionMediaGrant } from "./revision-media-grant";
import {
	buildClientRevisionPlayback,
	type ClientRevisionPlayback,
	planSharePlayback,
	publicRevisionPlaylistUrl,
	type SharePlaybackPlan,
} from "./revision-playback";
import {
	disabledInstantFinishPublication,
	getInstantFinishPublicationDto,
	type InstantFinishPublicationDto,
} from "./revision-publication-read";

export type LoadedRevisionPlayback = {
	publication: InstantFinishPublicationDto;
	plan: SharePlaybackPlan;
	playback: ClientRevisionPlayback | null;
	publicPlaylistUrl: string | null;
	thumbnailUnavailable: boolean;
};

export async function loadRevisionPlayback(input: {
	videoId: string;
	ownerId: string;
	origin: string;
	isScreenshot: boolean;
	hasActiveUpload: boolean;
	sourceType: string;
	env?: Record<string, string | undefined>;
}): Promise<LoadedRevisionPlayback> {
	let publication = disabledInstantFinishPublication();
	try {
		publication = await getInstantFinishPublicationDto({
			videoId: input.videoId,
			ownerId: input.ownerId,
		});
	} catch {
		publication = disabledInstantFinishPublication({
			enabled: isInstantFinishEnabledForOwner(input.ownerId),
		});
	}
	const eligibleLegacy =
		publication.enabled && !publication.currentRevisionId
			? await loadEligibleLegacy({
					videoId: input.videoId,
					ownerId: input.ownerId,
					env: input.env,
				})
			: false;
	const plan = planSharePlayback({
		enabled: publication.enabled,
		currentRevisionId: publication.currentRevisionId,
		isScreenshot: input.isScreenshot,
		hasActiveUpload: input.hasActiveUpload,
		sourceType: input.sourceType,
		eligibleLegacy,
	});
	if (!publication.enabled || eligibleLegacy) {
		return {
			publication,
			plan,
			playback: null,
			publicPlaylistUrl: null,
			thumbnailUnavailable: false,
		};
	}
	const grant = publication.currentRevisionId
		? await mintRevisionMediaGrant(null, input.videoId, {
				origin: input.origin,
			}).catch(() => null)
		: null;
	const playback = buildClientRevisionPlayback({
		publication,
		videoId: input.videoId,
		origin: input.origin,
		grant: grant && "grant" in grant ? grant.grant : null,
		eligibleLegacy,
	});
	return {
		publication,
		plan,
		playback,
		publicPlaylistUrl: publication.currentRevisionId
			? publicRevisionPlaylistUrl({
					origin: input.origin,
					videoId: input.videoId,
					revisionId: publication.currentRevisionId,
				})
			: null,
		thumbnailUnavailable:
			playback?.mode === "hls" ? playback.thumbnailUrl === null : true,
	};
}

import "server-only";

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
	const plan = planSharePlayback({
		enabled: publication.enabled,
		currentRevisionId: publication.currentRevisionId,
		isScreenshot: input.isScreenshot,
		hasActiveUpload: input.hasActiveUpload,
		sourceType: input.sourceType,
	});
	if (!publication.enabled) {
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
		grant: grant?.grant ?? null,
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

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
	disabledRevisionPublication,
	getRevisionPublication,
	type RevisionPublicationDto,
} from "./revision-publication";

export type LoadedRevisionPlayback = {
	publication: RevisionPublicationDto;
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
	let publication = disabledRevisionPublication();
	try {
		publication = await getRevisionPublication({
			videoId: input.videoId,
			ownerId: input.ownerId,
		});
	} catch {
		publication = {
			...disabledRevisionPublication(),
			enabled: isInstantFinishEnabledForOwner(input.ownerId),
		};
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
		? await mintRevisionMediaGrant({
				videoId: input.videoId,
				revisionId: publication.currentRevisionId,
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

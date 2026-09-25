import type { InstantFinishPublicationDto } from "./revision-publication-read";

export const REVISION_HLS_CONTENT_TYPE = "application/vnd.apple.mpegurl";

export type RevisionPlaybackMode = "legacy" | "hls" | "unavailable";

export type SharePlaybackPlan = {
	prefetchResultMp4: boolean;
	player: RevisionPlaybackMode;
	omitRawFallback: boolean;
	blockProcessingOverlay: boolean;
};

export type ClientRevisionPlayback =
	| {
			mode: "hls";
			videoId: string;
			revisionId: string;
			generation: number;
			playlistUrl: string;
			duration: number | null;
			captionsUrl: string | null;
			chapters: { title: string; start: number }[] | null;
			commentTimestamps: Record<string, number | null> | null;
			thumbnailUrl: string | null;
			downloadReady: boolean;
	  }
	| {
			mode: "unavailable";
			videoId: string;
			generation: number;
			downloadReady: false;
	  };

export function planSharePlayback(input: {
	enabled: boolean;
	currentRevisionId: string | null;
	isScreenshot: boolean;
	hasActiveUpload: boolean;
	sourceType: string;
}): SharePlaybackPlan {
	if (input.enabled) {
		return {
			prefetchResultMp4: false,
			player: input.currentRevisionId ? "hls" : "unavailable",
			omitRawFallback: true,
			blockProcessingOverlay: false,
		};
	}
	const isMp4 =
		input.sourceType === "desktopMP4" || input.sourceType === "webMP4";
	return {
		prefetchResultMp4: isMp4 && !input.isScreenshot && !input.hasActiveUpload,
		player: "legacy",
		omitRawFallback: false,
		blockProcessingOverlay: false,
	};
}

export function revisionMediaPath(
	videoId: string,
	revisionId: string,
	asset: string,
): string {
	return `/media/${videoId}/r/${revisionId}/${asset}`;
}

export function buildRevisionAssetUrl(input: {
	origin: string;
	videoId: string;
	revisionId: string;
	asset: string;
	grant: string;
}): string {
	const path = revisionMediaPath(input.videoId, input.revisionId, input.asset);
	const base = input.origin ? new URL(path, input.origin).toString() : path;
	const url = new URL(base, "http://revision.local");
	url.searchParams.set("t", input.grant);
	if (!input.origin) {
		return `${path}?${url.searchParams.toString()}`;
	}
	return url.toString();
}

export function publicRevisionPlaylistUrl(input: {
	origin: string;
	videoId: string;
	revisionId: string;
}): string {
	const path = revisionMediaPath(
		input.videoId,
		input.revisionId,
		"playlist.m3u8",
	);
	return input.origin ? new URL(path, input.origin).toString() : path;
}

export function redactMediaGrant(url: string): string {
	return url.replace(/([?&]t=)[^&]*/g, "$1[redacted]");
}

export function replacePlaylistGrant(url: string, grant: string): string {
	const parsed = new URL(url, "http://revision.local");
	parsed.searchParams.set("t", grant);
	if (url.startsWith("http://") || url.startsWith("https://")) {
		return parsed.toString();
	}
	return `${parsed.pathname}?${parsed.searchParams.toString()}`;
}

export function buildClientRevisionPlayback(input: {
	publication: InstantFinishPublicationDto;
	videoId: string;
	origin: string;
	grant: string | null;
}): ClientRevisionPlayback | null {
	if (!input.publication.enabled) return null;
	if (!input.publication.currentRevisionId || !input.grant) {
		return {
			mode: "unavailable",
			videoId: input.videoId,
			generation: input.publication.generation,
			downloadReady: false,
		};
	}
	const revisionId = input.publication.currentRevisionId;
	const metadata = input.publication.revisionMetadata;
	const assetUrl = (asset: string) =>
		buildRevisionAssetUrl({
			origin: input.origin,
			videoId: input.videoId,
			revisionId,
			asset,
			grant: input.grant as string,
		});
	return {
		mode: "hls",
		videoId: input.videoId,
		revisionId,
		generation: input.publication.generation,
		playlistUrl: assetUrl("playlist.m3u8"),
		duration: metadata?.duration ?? input.publication.duration,
		captionsUrl: metadata?.captionsAvailable ? assetUrl("captions.vtt") : null,
		chapters: metadata?.chapters ?? null,
		commentTimestamps: metadata?.commentTimestamps ?? null,
		thumbnailUrl: metadata?.thumbnailAvailable
			? assetUrl("thumbnail.jpg")
			: null,
		downloadReady: metadata?.downloadReady === true,
	};
}

export function applyRevisionCommentTimes<
	T extends { id: string; timestamp: number | null },
>(comments: T[], timestamps: Record<string, number | null> | null): T[] {
	return comments.map((comment) => {
		if (!timestamps || !Object.hasOwn(timestamps, comment.id)) {
			return { ...comment, timestamp: null };
		}
		const timestamp = timestamps[comment.id];
		return {
			...comment,
			timestamp: typeof timestamp === "number" ? timestamp : null,
		};
	});
}

export type GrantRefreshPlan = "reload-same" | "refresh-page" | "hold";

export function planGrantRefresh(input: {
	status: number;
	revisionId: string;
	body: { revisionId?: string; changed?: boolean; grant?: string } | null;
}): GrantRefreshPlan {
	if (input.status === 410 || input.body?.changed === true)
		return "refresh-page";
	if (
		input.status === 200 &&
		input.body?.revisionId &&
		input.body.revisionId !== input.revisionId
	) {
		return "refresh-page";
	}
	if (
		input.status === 200 &&
		input.body?.revisionId === input.revisionId &&
		typeof input.body.grant === "string" &&
		input.body.grant.length > 0
	) {
		return "reload-same";
	}
	return "hold";
}

export function filmstripForRevision(
	playback: ClientRevisionPlayback | null,
	legacy: { src: string; kind: "native" | "hls" } | null,
): { src: string; kind: "native" | "hls" } | null {
	if (!playback) return legacy;
	if (playback.mode === "unavailable") return null;
	return { src: playback.playlistUrl, kind: "hls" };
}

import type { Metadata } from "next";

const PLAYER_WIDTH = 1280;
const PLAYER_HEIGHT = 720;

export type ShareVideoSourceType =
	| "MediaConvert"
	| "local"
	| "desktopMP4"
	| "desktopSegments"
	| "webMP4";

export type ShareVideoMetadataInput = {
	videoId: string;
	name: string;
	sourceType: ShareVideoSourceType;
	webUrl: string;
	/**
	 * Two surfaces only answer on the default Cap origin: `proxy.ts` redirects
	 * `/embed/` away from a custom domain, and `parseCapShareUrl` accepts share
	 * URLs on `cap.so` and `cap.link` alone, so `/api/oembed` rejects a custom
	 * domain `url`. Defaults to `webUrl`.
	 */
	canonicalWebUrl?: string;
	advertiseIframelyPlayer?: boolean;
	revisionStreamUrl?: string;
	revisionThumbnailUnavailable?: boolean;
	revisionUnavailable?: boolean;
};

export const getShareVideoUrls = ({
	videoId,
	sourceType,
	webUrl,
	canonicalWebUrl = webUrl,
	revisionStreamUrl,
	revisionThumbnailUnavailable = false,
	revisionUnavailable = false,
}: Pick<
	ShareVideoMetadataInput,
	| "videoId"
	| "sourceType"
	| "webUrl"
	| "canonicalWebUrl"
	| "revisionStreamUrl"
	| "revisionThumbnailUnavailable"
	| "revisionUnavailable"
>) => {
	const shareUrl = new URL(`/s/${videoId}`, webUrl).toString();
	const canonicalShareUrl = new URL(
		`/s/${videoId}`,
		canonicalWebUrl,
	).toString();
	const playerUrl = new URL(`/embed/${videoId}`, canonicalWebUrl).toString();
	const streamUrl = new URL("/api/playlist", webUrl);
	streamUrl.searchParams.set("videoId", videoId);
	let streamContentType = "application/vnd.apple.mpegurl";
	if (revisionStreamUrl) {
		streamContentType = "application/vnd.apple.mpegurl";
	} else if (revisionUnavailable) {
		streamContentType = "application/vnd.apple.mpegurl";
	} else if (sourceType === "desktopMP4" || sourceType === "webMP4") {
		streamUrl.searchParams.set("videoType", "mp4");
		streamContentType = "video/mp4";
	} else if (sourceType === "desktopSegments") {
		streamUrl.searchParams.set("videoType", "segments-master");
		streamUrl.searchParams.set("requireComplete", "1");
	} else {
		streamUrl.searchParams.set("videoType", "master");
	}
	const previewImageUrl = new URL("/api/video/preview", webUrl);
	previewImageUrl.searchParams.set("videoId", videoId);
	previewImageUrl.searchParams.set("fallback", "og");
	const ogImageUrl = new URL("/api/video/og", webUrl);
	ogImageUrl.searchParams.set("videoId", videoId);
	const oEmbedUrl = new URL("/api/oembed", canonicalWebUrl);
	oEmbedUrl.searchParams.set("url", canonicalShareUrl);
	oEmbedUrl.searchParams.set("format", "json");

	return {
		shareUrl,
		playerUrl,
		streamUrl: revisionUnavailable
			? null
			: (revisionStreamUrl ?? streamUrl.toString()),
		streamContentType,
		previewImageUrl: revisionThumbnailUnavailable
			? null
			: previewImageUrl.toString(),
		ogImageUrl: revisionThumbnailUnavailable ? null : ogImageUrl.toString(),
		oEmbedUrl: oEmbedUrl.toString(),
	};
};

export const buildShareVideoMetadata = ({
	videoId,
	name,
	sourceType,
	webUrl,
	canonicalWebUrl,
	advertiseIframelyPlayer = false,
	revisionStreamUrl,
	revisionThumbnailUnavailable = false,
	revisionUnavailable = false,
}: ShareVideoMetadataInput): Metadata => {
	const urls = getShareVideoUrls({
		videoId,
		sourceType,
		webUrl,
		canonicalWebUrl,
		revisionStreamUrl,
		revisionThumbnailUnavailable,
		revisionUnavailable,
	});
	const title = `${name} | Cap Recording`;
	const description = "Watch this video on Cap";

	return {
		title,
		description,
		...(advertiseIframelyPlayer
			? {
					icons: {
						other: [
							{
								rel: "iframely player",
								url: urls.playerUrl,
								type: "text/html",
								media: "(aspect-ratio: 16/9)",
							},
						],
					},
				}
			: {}),
		alternates: {
			canonical: urls.shareUrl,
			types: {
				"application/json+oembed": [
					{
						title,
						url: urls.oEmbedUrl,
					},
				],
			},
		},
		openGraph: {
			type: "video.other",
			url: urls.shareUrl,
			siteName: "Cap",
			title,
			description,
			ttl: 300,
			images: [
				...(urls.previewImageUrl
					? [
							{
								url: urls.previewImageUrl,
								width: 480,
								height: 270,
								type: "image/gif",
							},
						]
					: []),
				...(urls.ogImageUrl
					? [
							{
								url: urls.ogImageUrl,
								width: 1200,
								height: 630,
								type: "image/png",
							},
						]
					: []),
			],
			videos:
				revisionUnavailable || !urls.streamUrl
					? []
					: [
							{
								url: urls.streamUrl,
								secureUrl: urls.streamUrl,
								width: PLAYER_WIDTH,
								height: PLAYER_HEIGHT,
								type: urls.streamContentType,
							},
						],
		},
		twitter: {
			card: "player",
			title,
			description,
			images: [urls.previewImageUrl, urls.ogImageUrl].filter(
				(url): url is string => typeof url === "string",
			),
			players: urls.streamUrl
				? {
						playerUrl: urls.playerUrl,
						streamUrl: urls.streamUrl,
						width: PLAYER_WIDTH,
						height: PLAYER_HEIGHT,
					}
				: undefined,
		},
		other: {
			"twitter:player:stream:content_type": urls.streamContentType,
		},
	};
};

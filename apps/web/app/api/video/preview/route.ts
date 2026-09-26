import { serverEnv } from "@cap/env";
import { provideOptionalAuth, Storage, Videos } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { type NextRequest, NextResponse } from "next/server";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import { previewRedirectOrigin } from "@/lib/mobile-request-origin";
import { revisionArtifactUrl } from "@/lib/revision-media-grant";
import { neutralPreviewJpeg } from "@/lib/revision-thumbnail";
import { runPromise } from "@/lib/server";

export const dynamic = "force-dynamic";

const PREVIEW_GIF_EXPIRES_SECONDS = 60 * 60;

function getPreviewGifKey(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/preview/animated-preview.gif`;
}

function getFallbackResponse(request: NextRequest, videoId: string) {
	if (request.nextUrl.searchParams.get("fallback") !== "og") {
		return new NextResponse(null, { status: 404 });
	}

	const fallbackUrl = new URL("/api/video/og", request.url);
	fallbackUrl.searchParams.set("videoId", videoId);
	const response = NextResponse.redirect(fallbackUrl, 302);
	response.headers.set("Cache-Control", "private, no-store, max-age=0");
	return response;
}

export async function GET(request: NextRequest) {
	const rawVideoId = request.nextUrl.searchParams.get("videoId");
	if (!rawVideoId) {
		return new NextResponse(null, { status: 400 });
	}

	const videoId = Video.VideoId.make(rawVideoId);
	let preview: { url: string | null; flagged: boolean } = {
		url: null,
		flagged: false,
	};
	try {
		preview = await Effect.gen(function* () {
			const videos = yield* Videos;
			const maybeVideo = yield* videos.getByIdForViewing(videoId);
			if (Option.isNone(maybeVideo)) return { url: null, flagged: false };

			const [video] = maybeVideo.value;
			const flagged = isInstantFinishEnabledForOwner(video.ownerId);
			if (flagged) {
				const url = yield* Effect.promise(() =>
					revisionArtifactUrl({
						videoId: video.id,
						ownerId: video.ownerId,
						artifact: "thumbnail",
						child: "thumbnail.jpg",
						origin: previewRedirectOrigin(
							serverEnv().WEB_URL,
							request.url,
							request.headers.get("x-forwarded-host") ??
								request.headers.get("host") ??
								undefined,
						),
					}),
				);
				return { url, flagged: true };
			}
			const [bucket] = yield* Storage.getAccessForVideo(video);
			const previewKey = getPreviewGifKey(video.ownerId, video.id);
			const hasPreview = yield* bucket.headObject(previewKey).pipe(
				Effect.as(true),
				Effect.catchAll(() => Effect.succeed(false)),
			);

			if (!hasPreview) return { url: null, flagged: false };

			return {
				url: yield* bucket.getSignedObjectUrl(previewKey, {
					expiresIn: PREVIEW_GIF_EXPIRES_SECONDS,
				}),
				flagged: false,
			};
		}).pipe(provideOptionalAuth, runPromise);
	} catch (error) {
		console.warn("[video/preview] Failed to resolve preview GIF:", error);
		return new NextResponse(null, { status: 404 });
	}

	if (!preview.url) {
		if (preview.flagged) {
			return new NextResponse(new Uint8Array(neutralPreviewJpeg()), {
				status: 200,
				headers: {
					"content-type": "image/jpeg",
					"cache-control": "private, no-store",
					"x-cap-thumbnail": "placeholder",
				},
			});
		}
		return getFallbackResponse(request, rawVideoId);
	}

	const response = NextResponse.redirect(preview.url, 302);
	response.headers.set(
		"Cache-Control",
		preview.flagged ? "private, no-store" : "public, max-age=300",
	);
	if (preview.flagged) response.headers.set("Referrer-Policy", "no-referrer");
	return response;
}

export const HEAD = GET;

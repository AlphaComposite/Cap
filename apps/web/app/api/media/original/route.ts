import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import {
	ownerOriginalObjectKey,
	privateSourceHeaders,
} from "@/lib/private-source-read";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export const dynamic = "force-dynamic";

async function readOriginal(request: NextRequest) {
	const rawVideoId = request.nextUrl.searchParams.get("videoId");
	if (!rawVideoId) return new NextResponse(null, { status: 400 });
	const user = await getCurrentUser();
	if (!user) return new NextResponse(null, { status: 401 });
	const videoId = Video.VideoId.make(rawVideoId);
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));
	if (!video) return new NextResponse(null, { status: 410 });
	if (video.ownerId !== user.id) return new NextResponse(null, { status: 403 });
	if (!isInstantFinishEnabledForOwner(video.ownerId)) {
		return new NextResponse(null, { status: 404 });
	}
	const key = await ownerOriginalObjectKey(videoId, video.ownerId);
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);
	if (!("getObjectResponse" in bucket)) {
		return new NextResponse(null, { status: 404 });
	}
	if (request.method === "HEAD") {
		const head = await bucket.headObject(key).pipe(runPromise);
		const headers = privateSourceHeaders();
		headers.set("Accept-Ranges", "bytes");
		if (head.ContentLength !== undefined) {
			headers.set("Content-Length", String(head.ContentLength));
		}
		if (head.ContentType) headers.set("Content-Type", head.ContentType);
		if (head.ETag) headers.set("ETag", head.ETag);
		return new Response(null, { status: 200, headers });
	}
	const upstream = await bucket
		.getObjectResponse(key, request.headers.get("range"), {
			signal: request.signal,
		})
		.pipe(runPromise);
	const headers = privateSourceHeaders(upstream.headers);
	headers.set("Accept-Ranges", "bytes");
	return new Response(upstream.body, {
		status: upstream.status,
		headers,
	});
}

export const GET = readOriginal;
export const HEAD = readOriginal;

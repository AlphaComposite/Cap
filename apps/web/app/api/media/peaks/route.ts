import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	editIntent,
	editRevision,
	sourceObject,
	videoEdits,
	videoPublication,
	videos,
} from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { selectEditorBaselineSpec } from "@/lib/editor-baseline";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import {
	parseRenderedCanonicalSpec,
	parseVideoEditSpec,
} from "@/lib/video-edits";
import {
	authoritativePeaksDuration,
	decodePeaksObject,
	validatePeaksAgainstDuration,
} from "@/lib/waveform-peaks";
import {
	authorizePeaksRead,
	peaksReadHeaders,
} from "@/lib/waveform-peaks-access";
import { readPeaksObject } from "@/lib/waveform-peaks-store";

export const dynamic = "force-dynamic";

function denied(status: number) {
	return new NextResponse(null, { status, headers: peaksReadHeaders() });
}

function parsedSpec(value: unknown) {
	try {
		return parseRenderedCanonicalSpec(value);
	} catch {
		try {
			return parseVideoEditSpec(value);
		} catch {
			return null;
		}
	}
}

export async function readPeaks(request: NextRequest) {
	const rawVideoId = request.nextUrl.searchParams.get("videoId");
	if (!rawVideoId) return denied(400);
	const user = await getCurrentUser();
	let videoId: Video.VideoId;
	try {
		videoId = Video.VideoId.make(rawVideoId);
	} catch {
		return denied(400);
	}
	const [video] = await db()
		.select({
			ownerId: videos.ownerId,
			duration: videos.duration,
		})
		.from(videos)
		.where(eq(videos.id, videoId));
	const [source] = video
		? await db()
				.select({ sha256: sourceObject.sha256 })
				.from(sourceObject)
				.where(eq(sourceObject.videoId, videoId))
		: [];
	const flagged = Boolean(
		video && isInstantFinishEnabledForOwner(video.ownerId),
	);
	const access = authorizePeaksRead({
		userId: user?.id ?? null,
		ownerId: video?.ownerId ?? null,
		videoFound: Boolean(video),
		flagged,
		registeredSha: source?.sha256 ?? null,
		videoId: rawVideoId,
	});
	if (access.status !== 200) return denied(access.status);
	const [legacy] = await db()
		.select({ editSpec: videoEdits.editSpec })
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId));
	const [published] = flagged
		? await db()
				.select({ canonicalSpec: editIntent.canonicalSpec })
				.from(editIntent)
				.innerJoin(
					videoPublication,
					and(
						eq(videoPublication.videoId, editIntent.videoId),
						eq(videoPublication.currentGeneration, editIntent.generation),
					),
				)
				.innerJoin(
					editRevision,
					and(
						eq(editRevision.revisionId, videoPublication.currentRevisionId),
						eq(editRevision.generation, editIntent.generation),
					),
				)
				.where(eq(editIntent.videoId, videoId))
		: [];
	let sourceDuration = video?.duration ?? 0;
	try {
		const baseline = selectEditorBaselineSpec({
			instantFinish: flagged,
			publishedIntentSpec: published
				? parsedSpec(published.canonicalSpec)
				: null,
			legacySpec: legacy?.editSpec ? parsedSpec(legacy.editSpec) : null,
			sourceDuration: video?.duration ?? 0,
		});
		sourceDuration = authoritativePeaksDuration({
			videoDuration: video?.duration,
			sourceDuration: baseline.sourceDuration,
		});
	} catch {
		sourceDuration = authoritativePeaksDuration({
			videoDuration: video?.duration,
			sourceDuration: null,
		});
	}
	const bytes = await readPeaksObject(access.key);
	if (!bytes) return denied(404);
	const decoded = decodePeaksObject(bytes, access.sha256);
	if (
		!decoded.ok ||
		!validatePeaksAgainstDuration({
			pairCount: decoded.pairs.length,
			sourceDuration: decoded.noAudio ? 1 : sourceDuration,
			noAudio: decoded.noAudio,
		})
	) {
		return denied(404);
	}
	const headers = peaksReadHeaders();
	headers.set("X-Cap-Source-Sha256", access.sha256);
	headers.set("Content-Length", String(bytes.byteLength));
	if (request.method === "HEAD") {
		return new Response(null, { status: 200, headers });
	}
	return new Response(Buffer.from(bytes), { status: 200, headers });
}

export const GET = readPeaks;
export const HEAD = readPeaks;

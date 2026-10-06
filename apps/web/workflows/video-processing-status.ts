import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { FatalError, sleep } from "workflow";

export interface ProcessedVideoMetadata {
	duration: number;
	width: number;
	height: number;
	fps: number;
}

type ProcessingStatus =
	| { status: "complete"; metadata: ProcessedVideoMetadata }
	| { status: "pending"; message: string }
	| { status: "failed"; message: string }
	| { status: "error"; message: string };

export class VideoProcessingFailedError extends Error {}

function isPositiveNumber(value: number | null): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

async function readCompletedVideo(videoId: string): Promise<ProcessingStatus> {
	const [video] = await db()
		.select({
			duration: videos.duration,
			width: videos.width,
			height: videos.height,
			fps: videos.fps,
		})
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)));
	if (
		!video ||
		!isPositiveNumber(video.width) ||
		!isPositiveNumber(video.height) ||
		!isPositiveNumber(video.fps)
	) {
		return {
			status: "error",
			message: "Processing completed but video metadata is missing",
		};
	}
	return {
		status: "complete",
		metadata: {
			duration: isPositiveNumber(video.duration) ? video.duration : 0,
			width: video.width,
			height: video.height,
			fps: video.fps,
		},
	};
}

export async function readVideoProcessingStatus(
	videoId: string,
): Promise<ProcessingStatus> {
	"use step";

	const [upload] = await db()
		.select({
			phase: videoUploads.phase,
			processingProgress: videoUploads.processingProgress,
			processingMessage: videoUploads.processingMessage,
			processingError: videoUploads.processingError,
		})
		.from(videoUploads)
		.where(eq(videoUploads.videoId, Video.VideoId.make(videoId)));

	if (!upload || upload.phase === "complete") {
		return readCompletedVideo(videoId);
	}
	if (upload.processingError || upload.phase === "error") {
		return {
			status: "failed",
			message:
				upload.processingError ||
				upload.processingMessage ||
				"Video processing failed",
		};
	}
	if (upload.phase === "processing" && upload.processingProgress === 100) {
		return readCompletedVideo(videoId);
	}
	return {
		status: "pending",
		message: [
			upload.phase,
			typeof upload.processingProgress === "number"
				? `${upload.processingProgress}%`
				: null,
			upload.processingMessage,
		]
			.filter(Boolean)
			.join(" "),
	};
}

export async function waitForVideoProcessing(
	videoId: string,
): Promise<ProcessedVideoMetadata> {
	const started = Date.now();
	const deadline = started + 60 * 60 * 1000;
	let lastStatus = "processing";
	// Fast reads while a typical recording finishes (~10-20s); the old backoff
	// alone left completion unseen for up to 10s. ponytail: fixed 1-minute fast
	// window; a webhook-resumed hook would remove polling if load ever matters.
	let slowAttempt = 0;
	while (Date.now() < deadline) {
		const result = await readVideoProcessingStatus(videoId);
		if (result.status === "complete") return result.metadata;
		if (result.status === "failed") {
			throw new VideoProcessingFailedError(result.message);
		}
		if (result.status === "error") throw new FatalError(result.message);
		lastStatus = result.message;
		await sleep(
			Date.now() - started < 60_000
				? 2_000
				: Math.min(5_000 * ++slowAttempt, 30_000),
		);
	}
	throw new FatalError(`Video processing timed out while ${lastStatus}`);
}

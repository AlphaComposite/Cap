import { db } from "@cap/database";
import { users, videos, videoUploads } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Video } from "@cap/web-domain";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { FatalError, sleep } from "workflow";
import { isAiGenerationEnabledForUser } from "@/lib/ai-generation-entitlement";
import {
	createMediaServerCapacityError,
	isMediaServerCapacityError,
} from "@/lib/media-server-backpressure";
import { transcribeVideo } from "@/lib/transcribe";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";
import {
	type ProcessedVideoMetadata,
	VideoProcessingFailedError,
	waitForVideoProcessing,
} from "./video-processing-status";

interface ProcessVideoWorkflowPayload {
	videoId: string;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
	recoveryClaimId?: string;
}

interface VideoProcessingResult {
	success: boolean;
	message: string;
	metadata?: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
}

const VIDEO_PROCESSING_RECOVERY_ACTIVE_LEASE_MS = 90 * 60 * 1000;
const INACTIVE_RECOVERY_ERROR =
	"Video processing recovery claim is no longer active";
const INACTIVE_UPLOAD_ERROR = "Video upload identity is no longer active";

function getAffectedRows(result: unknown) {
	const item = Array.isArray(result) ? result[0] : result;
	if (!item || typeof item !== "object" || !("affectedRows" in item)) return 0;
	return typeof item.affectedRows === "number" ? item.affectedRows : 0;
}

function getValidDuration(duration: number) {
	return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

export async function processVideoWorkflow(
	payload: ProcessVideoWorkflowPayload,
): Promise<VideoProcessingResult> {
	"use workflow";

	const { videoId, userId, rawFileKey, bucketId, recoveryClaimId } = payload;

	try {
		await validateProcessingRequest(videoId, rawFileKey, recoveryClaimId);

		let metadata: ProcessedVideoMetadata;
		for (let processingAttempt = 0; ; processingAttempt++) {
			let capacityRetryCount = 0;
			while (true) {
				try {
					await processVideoOnMediaServer(
						videoId,
						userId,
						rawFileKey,
						bucketId,
						recoveryClaimId,
					);
					break;
				} catch (error) {
					if (!isMediaServerCapacityError(error)) throw error;
					await markVideoWaitingForCapacity(
						videoId,
						rawFileKey,
						recoveryClaimId,
					);
					await sleep(`${Math.min(120, 15 + capacityRetryCount * 15)}s`);
					capacityRetryCount++;
				}
			}
			await renewRecoveryLease(videoId, rawFileKey, recoveryClaimId);
			try {
				metadata = await waitForVideoProcessing(videoId);
				break;
			} catch (error) {
				if (
					!(error instanceof VideoProcessingFailedError) ||
					processingAttempt >= 2
				) {
					throw error;
				}
				await markVideoWaitingForCapacity(videoId, rawFileKey, recoveryClaimId);
				await sleep(15_000 * (processingAttempt + 1));
			}
		}

		await saveMetadataAndComplete(
			videoId,
			rawFileKey,
			recoveryClaimId,
			metadata,
		);

		const outputKey = `${userId}/${videoId}/result.mp4`;
		if (rawFileKey !== outputKey) {
			await cleanupRawUpload(videoId, rawFileKey, recoveryClaimId);
		}

		await queueProcessedVideoTranscription(
			videoId,
			rawFileKey,
			recoveryClaimId,
		);
		await completeProcessing(videoId, rawFileKey, recoveryClaimId);

		return {
			success: true,
			message: "Video processing completed",
			metadata,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await setProcessingError(
			videoId,
			rawFileKey,
			recoveryClaimId,
			errorMessage,
		);
		throw new FatalError(errorMessage);
	}
}

async function validateProcessingRequest(
	videoId: string,
	rawFileKey: string,
	recoveryClaimId?: string,
): Promise<void> {
	"use step";

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	if (!video) {
		throw new FatalError("Video does not exist");
	}

	const [upload] = await db()
		.select()
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));

	if (!upload) {
		throw new FatalError("Upload does not exist");
	}

	if (upload.rawFileKey !== rawFileKey) {
		throw new FatalError("Upload raw file key does not match");
	}
	if (!recoveryClaimId && upload.recoveryClaimId != null) {
		throw new FatalError(INACTIVE_UPLOAD_ERROR);
	}

	if (recoveryClaimId) {
		const now = new Date();
		const result = await db()
			.update(videoUploads)
			.set({
				phase: "processing",
				processingProgress: 0,
				processingMessage: "Processing video",
				processingError: null,
				recoveryClaimId,
				recoveryLeaseExpiresAt: new Date(
					now.getTime() + VIDEO_PROCESSING_RECOVERY_ACTIVE_LEASE_MS,
				),
				updatedAt: now,
			})
			.where(
				and(
					eq(videoUploads.videoId, videoId as Video.VideoId),
					eq(videoUploads.phase, "error"),
					eq(videoUploads.rawFileKey, rawFileKey),
					eq(videoUploads.recoveryClaimId, recoveryClaimId),
					gt(videoUploads.recoveryLeaseExpiresAt, now),
				),
			);
		if (getAffectedRows(result) === 0) {
			throw new FatalError(INACTIVE_RECOVERY_ERROR);
		}
		return;
	}

	if (upload.phase !== "processing") {
		throw new FatalError("Upload is not ready for processing");
	}
}

const MEDIA_SERVER_START_MAX_ATTEMPTS = 2;
const MEDIA_SERVER_START_RETRY_BASE_MS = 250;
const MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS = 3 * 60 * 60;
const MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS = 3 * 60 * 60;

function getInputExtension(rawFileKey: string): string {
	const parts = rawFileKey.split(".");
	const extension = parts.at(-1)?.toLowerCase();

	if (!extension) {
		return ".mp4";
	}

	return `.${extension}`;
}

async function waitForRetry(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function startMediaServerProcessJob(
	mediaServerUrl: string,
	body: {
		videoId: string;
		userId: string;
		videoUrl: string;
		outputPresignedUrl: string;
		thumbnailPresignedUrl: string;
		previewGifPresignedUrl: string;
		webhookUrl: string;
		webhookSecret?: string;
		inputExtension: string;
		audioLevels?: boolean;
	},
	dispatchRequest: typeof fetch = fetch,
): Promise<string> {
	for (let attempt = 0; attempt < MEDIA_SERVER_START_MAX_ATTEMPTS; attempt++) {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (body.webhookSecret) {
			headers["x-media-server-secret"] = body.webhookSecret;
		}

		const response = await dispatchRequest(`${mediaServerUrl}/video/process`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});

		if (response.ok) {
			const { jobId } = (await response.json()) as { jobId: string };
			return jobId;
		}

		const errorData = (await response.json().catch(() => ({}))) as {
			error?: string;
			code?: string;
			details?: string;
			instanceId?: string;
			pid?: number;
			activeVideoProcesses?: number;
			maxConcurrentVideoProcesses?: number;
			jobCount?: number;
		};
		const baseErrorMessage =
			errorData.error ||
			errorData.details ||
			"Video processing failed to start";
		const busyDiagnostics =
			errorData.code === "SERVER_BUSY"
				? [
						errorData.instanceId ? `instance=${errorData.instanceId}` : null,
						typeof errorData.pid === "number" ? `pid=${errorData.pid}` : null,
						typeof errorData.activeVideoProcesses === "number" &&
						typeof errorData.maxConcurrentVideoProcesses === "number"
							? `active=${errorData.activeVideoProcesses}/${errorData.maxConcurrentVideoProcesses}`
							: null,
						typeof errorData.jobCount === "number"
							? `jobCount=${errorData.jobCount}`
							: null,
					]
						.filter(Boolean)
						.join(", ")
				: "";
		const errorMessage = busyDiagnostics
			? `${baseErrorMessage} (${busyDiagnostics})`
			: baseErrorMessage;
		const shouldRetry =
			response.status === 503 &&
			(errorData.code === "SERVER_BUSY" ||
				errorMessage.includes("Server is busy"));

		if (shouldRetry && attempt < MEDIA_SERVER_START_MAX_ATTEMPTS - 1) {
			await waitForRetry(MEDIA_SERVER_START_RETRY_BASE_MS * 2 ** attempt);
			continue;
		}

		if (shouldRetry) {
			throw createMediaServerCapacityError({
				response,
				message: errorMessage,
				videoId: body.videoId,
			});
		}

		throw new Error(errorMessage);
	}

	throw new Error("Video processing failed to start");
}

function activeRecoveryCondition(
	videoId: string,
	rawFileKey: string,
	recoveryClaimId: string,
	now = new Date(),
) {
	return and(
		eq(videoUploads.videoId, videoId as Video.VideoId),
		eq(videoUploads.phase, "processing"),
		eq(videoUploads.rawFileKey, rawFileKey),
		eq(videoUploads.recoveryClaimId, recoveryClaimId),
		gt(videoUploads.recoveryLeaseExpiresAt, now),
	);
}

function normalUploadOwnershipCondition(
	videoId: string,
	rawFileKey: string,
	phase: "processing" | "complete",
) {
	return and(
		eq(videoUploads.videoId, videoId as Video.VideoId),
		eq(videoUploads.phase, phase),
		eq(videoUploads.rawFileKey, rawFileKey),
		isNull(videoUploads.recoveryClaimId),
	);
}

function activeRecoveryExistsCondition(
	videoId: string,
	rawFileKey: string,
	recoveryClaimId: string,
	now: Date,
) {
	return sql`EXISTS (
		SELECT 1 FROM ${videoUploads}
		WHERE ${videoUploads.videoId} = ${videoId}
			AND ${videoUploads.phase} = 'processing'
			AND ${videoUploads.rawFileKey} = ${rawFileKey}
			AND ${videoUploads.recoveryClaimId} = ${recoveryClaimId}
			AND ${videoUploads.recoveryLeaseExpiresAt} > ${now}
	)`;
}

function transcriptionHandoffCondition(
	videoId: string,
	rawFileKey: string,
	recoveryClaimId: string | undefined,
	now: Date,
) {
	if (!recoveryClaimId) {
		return or(
			normalUploadOwnershipCondition(videoId, rawFileKey, "processing"),
			normalUploadOwnershipCondition(videoId, rawFileKey, "complete"),
		);
	}

	const identity = and(
		eq(videoUploads.videoId, videoId as Video.VideoId),
		eq(videoUploads.rawFileKey, rawFileKey),
		eq(videoUploads.recoveryClaimId, recoveryClaimId),
	);

	return and(
		identity,
		or(
			and(
				eq(videoUploads.phase, "processing"),
				gt(videoUploads.recoveryLeaseExpiresAt, now),
			),
			and(
				// A workflow step can retry after committing the handoff but before
				// dispatching. The same owner may resume while its recovery lease is
				// active; no recovery can claim a terminal upload.
				eq(videoUploads.phase, "complete"),
				gt(videoUploads.recoveryLeaseExpiresAt, now),
			),
		),
	);
}

async function renewRecoveryLease(
	videoId: string,
	rawFileKey: string,
	recoveryClaimId?: string,
): Promise<void> {
	"use step";

	if (!recoveryClaimId) return;
	const now = new Date();
	const result = await db()
		.update(videoUploads)
		.set({
			recoveryLeaseExpiresAt: new Date(
				now.getTime() + VIDEO_PROCESSING_RECOVERY_ACTIVE_LEASE_MS,
			),
			updatedAt: now,
		})
		.where(activeRecoveryCondition(videoId, rawFileKey, recoveryClaimId));
	if (getAffectedRows(result) === 0) {
		throw new FatalError(INACTIVE_RECOVERY_ERROR);
	}
}

async function withActiveRecoveryClaim<T>(
	videoId: string,
	rawFileKey: string,
	recoveryClaimId: string | undefined,
	action: () => Promise<T>,
): Promise<T> {
	return db().transaction(async (tx) => {
		const now = new Date();
		const result = await tx
			.update(videoUploads)
			.set(
				recoveryClaimId
					? {
							recoveryLeaseExpiresAt: new Date(
								now.getTime() + VIDEO_PROCESSING_RECOVERY_ACTIVE_LEASE_MS,
							),
							updatedAt: now,
						}
					: { updatedAt: now },
			)
			.where(
				recoveryClaimId
					? activeRecoveryCondition(videoId, rawFileKey, recoveryClaimId, now)
					: normalUploadOwnershipCondition(videoId, rawFileKey, "processing"),
			);
		if (getAffectedRows(result) === 0) {
			throw new FatalError(
				recoveryClaimId ? INACTIVE_RECOVERY_ERROR : INACTIVE_UPLOAD_ERROR,
			);
		}

		// The guarded update holds the upload row lock through the protected
		// action, preventing replacement between this fence and dispatch/delete.
		return action();
	});
}

async function processVideoOnMediaServer(
	videoId: string,
	userId: string,
	rawFileKey: string,
	_bucketId: string | null,
	recoveryClaimId?: string,
): Promise<void> {
	"use step";

	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	const webhookBaseUrl =
		serverEnv().MEDIA_SERVER_WEBHOOK_URL || serverEnv().WEB_URL;
	if (!mediaServerUrl) {
		throw new FatalError("MEDIA_SERVER_URL is not configured");
	}

	const now = new Date();
	const updateResult = await db()
		.update(videoUploads)
		.set({
			phase: "processing",
			processingProgress: 0,
			processingMessage: "Starting video processing...",
			processingError: null,
			...(recoveryClaimId
				? {
						recoveryLeaseExpiresAt: new Date(
							now.getTime() + VIDEO_PROCESSING_RECOVERY_ACTIVE_LEASE_MS,
						),
					}
				: {}),
			updatedAt: now,
		})
		.where(
			recoveryClaimId
				? activeRecoveryCondition(videoId, rawFileKey, recoveryClaimId, now)
				: normalUploadOwnershipCondition(videoId, rawFileKey, "processing"),
		);
	if (getAffectedRows(updateResult) === 0) {
		throw new FatalError(
			recoveryClaimId ? INACTIVE_RECOVERY_ERROR : INACTIVE_UPLOAD_ERROR,
		);
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, Video.VideoId.make(videoId)));

	if (!video) {
		throw new FatalError("Video does not exist");
	}

	const videoDomain = decodeStorageVideo(video);
	const [bucket] =
		await Storage.getAccessForVideo(videoDomain).pipe(runWorkflowPromise);
	const rawVideoUrl = await bucket
		.getInternalSignedObjectUrl(rawFileKey, {
			expiresIn: MEDIA_SERVER_PRESIGNED_GET_EXPIRES_SECONDS,
		})
		.pipe(runWorkflowPromise);
	const outputKey = `${userId}/${videoId}/result.mp4`;
	const thumbnailKey = `${userId}/${videoId}/screenshot/screen-capture.jpg`;
	const previewGifKey = `${userId}/${videoId}/preview/animated-preview.gif`;
	const outputPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			outputKey,
			{ ContentType: "video/mp4" },
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runWorkflowPromise);
	const thumbnailPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			thumbnailKey,
			{ ContentType: "image/jpeg" },
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runWorkflowPromise);
	const previewGifPresignedUrl = await bucket
		.getInternalPresignedPutUrl(
			previewGifKey,
			{
				ContentType: "image/gif",
				CacheControl: "public, max-age=31536000, immutable",
			},
			{ expiresIn: MEDIA_SERVER_PRESIGNED_PUT_EXPIRES_SECONDS },
		)
		.pipe(runWorkflowPromise);
	const webhookUrl = `${webhookBaseUrl}/api/webhooks/media-server/progress?retryable=true`;
	const webhookSecret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;

	await startMediaServerProcessJob(
		mediaServerUrl,
		{
			audioLevels: video.source.type === "webMP4",
			videoId,
			userId,
			videoUrl: rawVideoUrl,
			outputPresignedUrl,
			thumbnailPresignedUrl,
			previewGifPresignedUrl,
			webhookUrl,
			webhookSecret: webhookSecret || undefined,
			inputExtension: getInputExtension(rawFileKey),
		},
		(input, init) =>
			withActiveRecoveryClaim(videoId, rawFileKey, recoveryClaimId, () =>
				fetch(input, init),
			),
	);
}

async function saveMetadataAndComplete(
	videoId: string,
	rawFileKey: string,
	recoveryClaimId: string | undefined,
	metadata: { duration: number; width: number; height: number; fps: number },
): Promise<void> {
	"use step";

	await renewRecoveryLease(videoId, rawFileKey, recoveryClaimId);
	const duration = getValidDuration(metadata.duration);
	const now = new Date();
	const changes = {
		width: metadata.width,
		height: metadata.height,
		fps: metadata.fps,
		...(duration === undefined ? {} : { duration }),
	};

	if (!recoveryClaimId) {
		await db().transaction(async (tx) => {
			const identityResult = await tx
				.update(videoUploads)
				.set({ updatedAt: now })
				.where(
					normalUploadOwnershipCondition(videoId, rawFileKey, "processing"),
				);
			if (getAffectedRows(identityResult) === 0) {
				throw new FatalError(INACTIVE_UPLOAD_ERROR);
			}
			await tx
				.update(videos)
				.set(changes)
				.where(eq(videos.id, videoId as Video.VideoId));
		});
		return;
	}

	const result = await db()
		.update(videos)
		.set(changes)
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				recoveryClaimId
					? activeRecoveryExistsCondition(
							videoId,
							rawFileKey,
							recoveryClaimId,
							now,
						)
					: undefined,
			),
		);
	if (recoveryClaimId && getAffectedRows(result) === 0) {
		throw new FatalError(INACTIVE_RECOVERY_ERROR);
	}
}

async function cleanupRawUpload(
	videoId: string,
	rawFileKey: string,
	recoveryClaimId?: string,
): Promise<void> {
	"use step";

	await renewRecoveryLease(videoId, rawFileKey, recoveryClaimId);
	try {
		const [video] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, Video.VideoId.make(videoId)));
		if (!video) return;
		const videoDomain = decodeStorageVideo(video);
		const [bucket] =
			await Storage.getAccessForVideo(videoDomain).pipe(runWorkflowPromise);
		await withActiveRecoveryClaim(videoId, rawFileKey, recoveryClaimId, () =>
			bucket.deleteObject(rawFileKey).pipe(runWorkflowPromise),
		);
	} catch (error) {
		if (
			error instanceof FatalError &&
			(error.message === INACTIVE_RECOVERY_ERROR ||
				error.message === INACTIVE_UPLOAD_ERROR)
		) {
			throw error;
		}
		console.error("[process-video] Failed to delete raw upload", error);
	}
}

async function queueProcessedVideoTranscription(
	videoId: string,
	rawFileKey: string,
	recoveryClaimId?: string,
): Promise<void> {
	"use step";

	await renewRecoveryLease(videoId, rawFileKey, recoveryClaimId);
	try {
		const [owner] = await db()
			.select({
				id: videos.ownerId,
				stripeSubscriptionStatus: users.stripeSubscriptionStatus,
				thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
			})
			.from(videos)
			.innerJoin(users, eq(videos.ownerId, users.id))
			.where(eq(videos.id, Video.VideoId.make(videoId)));
		if (!owner) return;

		const now = new Date();
		const handoffResult = await db()
			.update(videoUploads)
			.set({
				phase: "complete",
				processingProgress: 100,
				processingMessage: "Video processing complete",
				processingError: null,
				updatedAt: now,
			})
			.where(
				transcriptionHandoffCondition(
					videoId,
					rawFileKey,
					recoveryClaimId,
					now,
				),
			);
		if (getAffectedRows(handoffResult) === 0) {
			throw new FatalError(
				recoveryClaimId ? INACTIVE_RECOVERY_ERROR : INACTIVE_UPLOAD_ERROR,
			);
		}

		const result = await transcribeVideo(
			Video.VideoId.make(videoId),
			owner.id,
			isAiGenerationEnabledForUser(owner),
		);
		if (!result.success) {
			console.warn("[process-video] Failed to queue transcription", {
				videoId,
				message: result.message,
			});
		}
	} catch (error) {
		if (
			error instanceof FatalError &&
			(error.message === INACTIVE_RECOVERY_ERROR ||
				error.message === INACTIVE_UPLOAD_ERROR)
		) {
			throw error;
		}
		console.warn("[process-video] Failed to queue transcription", {
			videoId,
			error,
		});
	}
}

async function completeProcessing(
	videoId: string,
	rawFileKey: string,
	recoveryClaimId?: string,
): Promise<void> {
	"use step";

	const result = await db()
		.delete(videoUploads)
		.where(
			recoveryClaimId
				? and(
						eq(videoUploads.videoId, videoId as Video.VideoId),
						eq(videoUploads.phase, "complete"),
						eq(videoUploads.rawFileKey, rawFileKey),
						eq(videoUploads.recoveryClaimId, recoveryClaimId),
					)
				: normalUploadOwnershipCondition(videoId, rawFileKey, "complete"),
		);
	// Cleanup is deliberately idempotent. The guarded terminal handoff above
	// owns dispatch; a missing or replaced row must neither fail a retry nor be
	// deleted by an obsolete recovery workflow.
	void result;
}

async function setProcessingError(
	videoId: string,
	rawFileKey: string,
	recoveryClaimId: string | undefined,
	errorMessage: string,
): Promise<void> {
	"use step";

	const now = new Date();
	await db()
		.update(videoUploads)
		.set({
			phase: "error",
			processingProgress: 0,
			processingMessage: "Video processing failed",
			processingError: errorMessage,
			...(recoveryClaimId
				? { recoveryClaimId: null, recoveryLeaseExpiresAt: null }
				: {}),
			updatedAt: now,
		})
		.where(
			recoveryClaimId
				? activeRecoveryCondition(videoId, rawFileKey, recoveryClaimId, now)
				: normalUploadOwnershipCondition(videoId, rawFileKey, "processing"),
		);
}

async function markVideoWaitingForCapacity(
	videoId: string,
	rawFileKey: string,
	recoveryClaimId?: string,
): Promise<void> {
	"use step";

	const now = new Date();
	const result = await db()
		.update(videoUploads)
		.set({
			processingMessage: "Queued for video processing...",
			processingError: null,
			...(recoveryClaimId
				? {
						recoveryLeaseExpiresAt: new Date(
							now.getTime() + VIDEO_PROCESSING_RECOVERY_ACTIVE_LEASE_MS,
						),
					}
				: {}),
			updatedAt: now,
		})
		.where(
			recoveryClaimId
				? activeRecoveryCondition(videoId, rawFileKey, recoveryClaimId, now)
				: normalUploadOwnershipCondition(videoId, rawFileKey, "processing"),
		);
	if (getAffectedRows(result) === 0) {
		throw new FatalError(
			recoveryClaimId ? INACTIVE_RECOVERY_ERROR : INACTIVE_UPLOAD_ERROR,
		);
	}
}

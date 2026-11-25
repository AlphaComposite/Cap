import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@cap/database";
import {
	organizations,
	sourceRelocation,
	videoEdits,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { VideoEditSpec, VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import {
	type AiGenerationLanguage,
	parseAiGenerationLanguage,
	Video,
} from "@cap/web-domain";
import { AssemblyAI } from "assemblyai";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Either, Option, Schema } from "effect";
import { FatalError } from "workflow";
import { start } from "workflow/api";
import { getAssemblyAITranscriptionOptions } from "@/lib/assemblyai";
import {
	ENHANCED_AUDIO_CONTENT_TYPE,
	ENHANCED_AUDIO_EXTENSION,
	enhanceAudioFromUrl,
} from "@/lib/audio-enhance";
import { checkHasAudioTrack, extractAudioFromUrl } from "@/lib/audio-extract";
import {
	createEditTranscript,
	editTranscriptWordsToCaptionVtt,
	getEditTranscriptBackfillStatus,
	getEditTranscriptObjectKey,
	serializeEditTranscript,
} from "@/lib/edit-transcript";
import { encryptEditTranscriptObject } from "@/lib/edit-transcript-storage";
import { startAiGeneration } from "@/lib/generate-ai";
import { getLiveTranscriptObjectKey } from "@/lib/live-transcribe-core";
import {
	checkHasAudioTrackViaMediaServer,
	extractAudioViaMediaServer,
	isMediaServerConfigured,
	probeVideoViaMediaServer,
} from "@/lib/media-client";
import { resolveLiveOriginal } from "@/lib/private-source-read";
import { planSegmentsAudioExtraction } from "@/lib/segments-audio";
import { downloadConcatenatedSegments } from "@/lib/segments-audio-download";
import type { RelocationState } from "@/lib/source-relocation";
import {
	assertNoSpeakerLabelClaim,
	assertSpeakerLabelSource,
	hasLegacyTranscriptAdmission,
	isSpeakerLabelCanary,
	loadSpeakerLabelClaim,
	loadSpeakerLabelSource,
	persistSpeakerLabelId,
	pollSpeakerLabelTranscript,
	reserveSpeakerLabelRecording,
	reserveSpeakerLabelSubmit,
	type SpeakerLabelClaim,
	type SpeakerLabelSource,
} from "@/lib/speaker-label-claim";
import {
	transcribeSourceCandidateKeys,
	transcribeTempAudioKey,
} from "@/lib/transcribe-source";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

interface TranscribeWorkflowPayload {
	videoId: string;
	userId: string;
	aiGenerationEnabled: boolean;
	/**
	 * The recording's segments are fully uploaded but the mux into result.mp4
	 * has not finished; transcribe directly from the segment audio and defer
	 * back to the normal post-mux queue if that isn't possible.
	 */
	earlyFromSegments?: boolean;
}

interface VideoData {
	video: typeof videos.$inferSelect;
	transcriptionDisabled: boolean;
	aiGenerationLanguage: AiGenerationLanguage;
	speakerLabels: boolean;
	speakerLabelCompleted?: boolean;
	speakerLabelTranscriptId?: string;
	speakerLabelReservationToken?: string;
}

interface BackfillEditTranscriptPayload {
	videoId: string;
	userId: string;
	requestId: string;
}

const EDIT_TRANSCRIPT_TEMP_AUDIO_FILENAME = "audio-edit-transcript-v3-temp.mp3";

interface TranscriptionArtifacts {
	vtt: string;
	editTranscript: string;
	speakerLabelClaim?: SpeakerLabelClaim;
}

export async function transcribeVideoWorkflow(
	payload: TranscribeWorkflowPayload,
) {
	"use workflow";

	const { videoId, userId, aiGenerationEnabled } = payload;

	let videoData: VideoData;
	try {
		videoData = await validateVideo(videoId, userId, payload.earlyFromSegments);
	} catch (error) {
		await markError(videoId);
		throw error;
	}

	if (videoData.speakerLabelCompleted) {
		return {
			success: true,
			message: "Speaker-labeled transcription already completed",
		};
	}
	if (videoData.transcriptionDisabled) {
		await markSkipped(videoId);
		return { success: true, message: "Transcription disabled - skipped" };
	}

	// An accepted ID no longer needs the uploaded audio, even after a crash.
	const tempAudioFilename =
		videoData.speakerLabelReservationToken || videoData.speakerLabelTranscriptId
			? "audio-temp-speaker.mp3"
			: undefined;
	const ownsTempAudio =
		!videoData.speakerLabels || tempAudioFilename !== undefined;

	try {
		if (videoData.speakerLabelTranscriptId) {
			await saveTranscription(
				videoId,
				userId,
				videoData.video,
				await pollSpeakerLabeledTranscription(
					videoData.speakerLabelTranscriptId,
					Math.max(0, (videoData.video.duration ?? 0) * 1000),
					videoId,
				),
			);
		} else {
			const speakerLabelSource = videoData.speakerLabels
				? await prepareSpeakerLabelSource(videoId, userId, videoData.video)
				: undefined;
			let audioUrl: string | null;
			let videoDurationMs = Math.max(0, (videoData.video.duration ?? 0) * 1000);

			if (payload.earlyFromSegments) {
				const segments = await extractAudioFromSegmentsStep(
					videoId,
					userId,
					videoData.video,
				);

				if (segments.status === "no-audio") {
					await markNoAudio(videoId);
					return {
						success: true,
						message: "Video has no audio track - skipped transcription",
					};
				}

				if (segments.status !== "ok" || !segments.audioUrl) {
					// The early path must never end worse than today's timing: clean up
					// while we still hold the claim, release it, then explicitly re-offer
					// the video to the normal path — the post-mux queue may have already
					// run and been rejected by our claim, so we cannot rely on it firing
					// again.
					await cleanupTempAudio(videoId, userId, videoData.video);
					await deferEarlyTranscription(videoId);
					await requeueAfterEarlyDefer(videoId, userId, aiGenerationEnabled);
					return {
						success: true,
						message: `Early transcription deferred: ${
							segments.status === "unavailable"
								? segments.reason
								: "no audio URL"
						}`,
					};
				}

				audioUrl = segments.audioUrl;
				if (videoDurationMs <= 0 && (segments.durationMs ?? 0) > 0) {
					videoDurationMs = segments.durationMs ?? 0;
				}
			} else {
				audioUrl = await extractAudio(
					videoId,
					userId,
					videoData.video,
					tempAudioFilename,
					speakerLabelSource?.sourceKey,
					videoData.speakerLabels,
				);
			}

			if (!audioUrl) {
				await markNoAudio(videoId);
				return {
					success: true,
					message: "Video has no audio track - skipped transcription",
				};
			}

			const transcription =
				videoData.speakerLabels && !payload.earlyFromSegments
					? await pollSpeakerLabeledTranscription(
							await submitSpeakerLabeledTranscription(
								audioUrl,
								videoData.aiGenerationLanguage,
								speakerLabelSource,
								videoData.speakerLabelReservationToken,
							),
							videoDurationMs,
							videoId,
						)
					: await transcribeWithAssemblyAI(
							audioUrl,
							videoData.aiGenerationLanguage,
							videoDurationMs,
							videoId,
						);

			await saveTranscription(videoId, userId, videoData.video, transcription);
		}
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"message" in error &&
			typeof error.message === "string" &&
			error.message.toLowerCase().includes("no spoken audio")
		) {
			await markNoAudio(videoId);
			if (ownsTempAudio)
				await cleanupTempAudio(
					videoId,
					userId,
					videoData.video,
					tempAudioFilename,
				);
			return {
				success: true,
				message: "Video has no spoken audio - skipped transcription",
			};
		}

		await markError(
			videoId,
			videoData.speakerLabelReservationToken,
			videoData.speakerLabelTranscriptId,
		);
		if (ownsTempAudio)
			await cleanupTempAudio(
				videoId,
				userId,
				videoData.video,
				tempAudioFilename,
			);
		throw error;
	}

	if (ownsTempAudio)
		await cleanupTempAudio(videoId, userId, videoData.video, tempAudioFilename);

	if (aiGenerationEnabled) {
		await queueAiGeneration(videoId, userId);
	}

	return { success: true, message: "Transcription completed successfully" };
}

export async function backfillEditTranscriptWorkflow(
	payload: BackfillEditTranscriptPayload,
) {
	"use workflow";

	const { videoId, userId, requestId } = payload;
	let video: typeof videos.$inferSelect;

	try {
		video = await validateEditTranscriptBackfill(videoId, userId, requestId);
		// Legacy videos only: the transcript must describe the ORIGINAL media, so
		// edited videos are transcribed from their preserved source mp4.
		const videoEdit = await loadVideoEditForBackfill(videoId);
		const audioUrl = await extractAudio(
			videoId,
			userId,
			video,
			EDIT_TRANSCRIPT_TEMP_AUDIO_FILENAME,
			videoEdit?.sourceKey,
		);
		if (!audioUrl) {
			await saveEditTranscriptBackfillError(videoId, requestId, video);
			return { success: false };
		}

		const editTranscript = await transcribeEditTranscriptWithAssemblyAI(
			audioUrl,
			videoEdit ? videoEdit.editSpec.sourceDuration : (video.duration ?? 0),
			videoId,
		);
		await saveEditTranscriptBackfill(
			videoId,
			userId,
			requestId,
			video,
			editTranscript,
		);
		await cleanupTempAudio(
			videoId,
			userId,
			video,
			EDIT_TRANSCRIPT_TEMP_AUDIO_FILENAME,
		);
		return { success: true };
	} catch (error) {
		console.error(
			`[transcribe] Editable transcript backfill failed for ${videoId}`,
			error,
		);
		const loadedVideo = await loadVideoForEditTranscriptBackfill(videoId);
		if (loadedVideo?.ownerId === userId) {
			await saveEditTranscriptBackfillError(videoId, requestId, loadedVideo);
			await cleanupTempAudio(
				videoId,
				userId,
				loadedVideo,
				EDIT_TRANSCRIPT_TEMP_AUDIO_FILENAME,
			);
		}
		return { success: false };
	}
}

async function validateVideo(
	videoId: string,
	userId: string,
	earlyFromSegments?: boolean,
): Promise<VideoData> {
	"use step";

	if (!serverEnv().ASSEMBLY_API_KEY) {
		throw new FatalError("Missing ASSEMBLY_API_KEY");
	}

	const query = await db()
		.select({
			video: videos,
			settings: videos.settings,
			orgSettings: organizations.settings,
		})
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (query.length === 0) {
		throw new FatalError("Video does not exist");
	}

	const result = query[0];
	if (!result?.video) {
		throw new FatalError("Video information is missing");
	}

	const transcriptionDisabled =
		result.video.settings?.disableTranscript ??
		result.orgSettings?.disableTranscript ??
		false;
	const selected = !earlyFromSegments && isSpeakerLabelCanary(result.video);
	const legacyAdmission =
		selected && (await hasLegacyTranscriptAdmission(videoId));
	let existingClaim = await loadSpeakerLabelClaim(videoId);
	const speakerLabels =
		existingClaim !== null || (selected && !legacyAdmission);
	if (speakerLabels && result.video.transcriptionStatus === "COMPLETE") {
		if (!existingClaim?.transcriptId) {
			throw new FatalError(
				"Speaker-label canary cannot backfill an existing transcript",
			);
		}
		return {
			video: result.video,
			transcriptionDisabled,
			aiGenerationLanguage: parseAiGenerationLanguage(
				result.orgSettings?.aiGenerationLanguage,
			),
			speakerLabels,
			speakerLabelCompleted: true,
		};
	}
	if (speakerLabels && (earlyFromSegments || transcriptionDisabled)) {
		throw new FatalError(
			"Speaker-label claim holds this recording; reconciliation required",
		);
	}
	if (speakerLabels && result.video.ownerId !== userId) {
		throw new FatalError("Speaker-label recording owner changed");
	}
	if (existingClaim && !existingClaim.transcriptId) {
		throw new FatalError(
			"Speaker-labeled submission outcome unknown; do not resubmit",
		);
	}
	let speakerLabelCompleted = false;
	if (speakerLabels) {
		const admission = await reserveSpeakerLabelRecording(
			result.video,
			parseAiGenerationLanguage(result.orgSettings?.aiGenerationLanguage),
		);
		existingClaim = admission.claim;
		speakerLabelCompleted = admission.completed;
		if (
			existingClaim.state === "accepted" &&
			(existingClaim.ownerId !== result.video.ownerId ||
				existingClaim.bucket !== (result.video.bucket ?? null) ||
				existingClaim.storageIntegrationId !==
					(result.video.storageIntegrationId ?? null))
		) {
			throw new FatalError("Speaker-label recording storage changed");
		}
	} else {
		const transition = await db()
			.update(videos)
			.set({ transcriptionStatus: "PROCESSING" })
			.where(
				and(
					eq(videos.id, videoId as Video.VideoId),
					sql`(${videos.transcriptionStatus} IS NULL OR ${videos.transcriptionStatus} <> 'COMPLETE')`,
				),
			);
		if (!Array.isArray(transition) || transition[0]?.affectedRows !== 1) {
			throw new FatalError("Transcription already completed or unavailable");
		}
	}

	return {
		video: result.video,
		transcriptionDisabled,
		aiGenerationLanguage: parseAiGenerationLanguage(
			result.orgSettings?.aiGenerationLanguage,
		),
		speakerLabels,
		speakerLabelCompleted,
		speakerLabelTranscriptId: existingClaim?.transcriptId,
		speakerLabelReservationToken:
			existingClaim?.state === "reserved" ? existingClaim.token : undefined,
	};
}

export async function prepareSpeakerLabelSource(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
): Promise<SpeakerLabelSource> {
	"use step";
	const source = await loadSpeakerLabelSource(videoId, userId);
	if (
		(video.bucket ?? null) !== source.bucket ||
		(video.storageIntegrationId ?? null) !== source.storageIntegrationId
	) {
		throw new FatalError("Speaker-label recording storage changed");
	}
	return source;
}

prepareSpeakerLabelSource.maxRetries = 60;

async function loadVideoForEditTranscriptBackfill(videoId: string) {
	"use step";

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));
	return video ?? null;
}

async function loadVideoEditForBackfill(
	videoId: string,
): Promise<{ sourceKey: string; editSpec: VideoEditSpec } | null> {
	"use step";

	const [edit] = await db()
		.select({
			sourceKey: videoEdits.sourceKey,
			editSpec: videoEdits.editSpec,
		})
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId as Video.VideoId));

	return edit ?? null;
}

async function validateEditTranscriptBackfill(
	videoId: string,
	userId: string,
	requestId: string,
) {
	"use step";

	if (!serverEnv().ASSEMBLY_API_KEY) {
		throw new FatalError("Missing ASSEMBLY_API_KEY");
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));
	if (!video || video.ownerId !== userId) {
		throw new FatalError("Video does not exist");
	}
	if (
		video.transcriptionStatus !== "COMPLETE" ||
		video.isScreenshot ||
		(video.source.type !== "desktopMP4" && video.source.type !== "webMP4") ||
		!video.duration ||
		video.duration <= 0
	) {
		throw new FatalError("Transcript editing is not available");
	}
	const status = getEditTranscriptBackfillStatus(video.metadata);
	if (status?.status !== "processing" || status.requestId !== requestId) {
		throw new FatalError("Transcript request expired");
	}

	return video;
}

/**
 * Every terminal transcription outcome must clear the live-transcription
 * metadata flag, or share pages keep polling for a live transcript that can
 * never resolve. Guarded so videos without the flag see a 0-row update.
 */
async function clearLiveTranscriptFlag(
	videoId: string,
	executor?: Pick<ReturnType<typeof db>, "update">,
): Promise<void> {
	try {
		await (executor ?? db())
			.update(videos)
			.set({
				metadata: sql`JSON_REMOVE(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.liveTranscript')`,
				updatedAt: sql`${videos.updatedAt}`,
			})
			.where(
				and(
					eq(videos.id, videoId as Video.VideoId),
					sql`JSON_EXTRACT(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.liveTranscript') IS NOT NULL`,
				),
			);
	} catch (error) {
		console.warn(
			`[transcribe] Failed to clear live transcript flag for ${videoId}`,
			error,
		);
	}
}

async function markSkipped(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({ transcriptionStatus: "SKIPPED" })
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				eq(videos.transcriptionStatus, "PROCESSING"),
			),
		);
	await clearLiveTranscriptFlag(videoId);
}

async function markNoAudio(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({ transcriptionStatus: "NO_AUDIO" })
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				eq(videos.transcriptionStatus, "PROCESSING"),
			),
		);
	await clearLiveTranscriptFlag(videoId);
}

async function markError(
	videoId: string,
	reservationToken?: string,
	transcriptId?: string,
): Promise<void> {
	"use step";

	await db().transaction(async (tx) => {
		// Match admission's lock order so a new claim cannot slip past this check.
		await tx.execute(
			sql`SELECT id FROM videos WHERE id = ${videoId} FOR UPDATE`,
		);
		const claim = await loadSpeakerLabelClaim(videoId, tx);
		const canWrite = reservationToken
			? claim?.token === reservationToken
			: transcriptId
				? claim?.transcriptId === transcriptId
				: !claim;
		if (!canWrite) return;

		await tx
			.update(videos)
			.set({ transcriptionStatus: "ERROR" })
			.where(
				and(
					eq(videos.id, videoId as Video.VideoId),
					eq(videos.transcriptionStatus, "PROCESSING"),
				),
			);
		await clearLiveTranscriptFlag(videoId, tx);
	});
}

async function deferEarlyTranscription(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({ transcriptionStatus: null })
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				eq(videos.transcriptionStatus, "PROCESSING"),
			),
		);
}

/**
 * After an early-path deferral, put the video back on the normal
 * transcription path. Mirrors lib/transcribe.ts semantics without importing
 * it (that would be a module cycle): no-op while the mux still owns the
 * upload row — its completion queues transcription — otherwise claim and
 * start a normal (non-early) workflow right away.
 */
async function requeueAfterEarlyDefer(
	videoId: string,
	userId: string,
	aiGenerationEnabled: boolean,
): Promise<void> {
	"use step";

	const upload = await db()
		.select({ phase: videoUploads.phase })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId))
		.limit(1);

	if (
		upload[0]?.phase === "uploading" ||
		upload[0]?.phase === "processing" ||
		upload[0]?.phase === "generating_thumbnail"
	) {
		return;
	}

	const claim = await db()
		.update(videos)
		.set({ transcriptionStatus: "PROCESSING" })
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				isNull(videos.transcriptionStatus),
			),
		);
	const affectedRows = Array.isArray(claim)
		? ((claim[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0)
		: ((claim as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
	if (affectedRows === 0) return;

	try {
		await start(transcribeVideoWorkflow, [
			{ videoId, userId, aiGenerationEnabled },
		]);
	} catch (error) {
		await db()
			.update(videos)
			.set({ transcriptionStatus: null })
			.where(eq(videos.id, videoId as Video.VideoId));
		throw error;
	}
}

async function audioBufferFromSignedUrl(
	videoUrl: string,
	videoId: string,
): Promise<Buffer | null> {
	const useMediaServer = isMediaServerConfigured();
	console.log(
		`[transcribe] Audio detection: useMediaServer=${useMediaServer}, videoId=${videoId}`,
	);
	if (useMediaServer) {
		let hasAudio: boolean;
		try {
			const probe = await probeVideoViaMediaServer(videoUrl);
			console.log(
				`[transcribe] Probe result for ${videoId}: audioCodec=${probe.audioCodec}, videoCodec=${probe.videoCodec}, duration=${probe.duration}, audioChannels=${probe.audioChannels}, sampleRate=${probe.sampleRate}`,
			);
			hasAudio = probe.audioCodec !== null;
		} catch (probeError) {
			console.error(
				`[transcribe] Probe failed for ${videoId}, falling back to audio check:`,
				probeError,
			);
			hasAudio = await checkHasAudioTrackViaMediaServer(videoUrl);
			console.log(
				`[transcribe] Fallback audio check result for ${videoId}: hasAudio=${hasAudio}`,
			);
		}
		if (!hasAudio) {
			console.log(
				`[transcribe] No audio track detected for ${videoId} via media server`,
			);
			return null;
		}
		return extractAudioViaMediaServer(videoUrl);
	}
	const hasAudio = await checkHasAudioTrack(videoUrl);
	console.log(
		`[transcribe] Local ffmpeg audio check for ${videoId}: hasAudio=${hasAudio}`,
	);
	if (!hasAudio) return null;
	const result = await extractAudioFromUrl(videoUrl);
	try {
		return await fs.readFile(result.filePath);
	} finally {
		await result.cleanup();
	}
}

async function extractAudio(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	tempAudioFilename = "audio-temp.mp3",
	sourceKeyOverride?: string,
	strictSourceKey = false,
): Promise<string | null> {
	"use step";

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);

	let videoUrl: string;
	try {
		videoUrl = await resolveVideoSourceUrl(
			videoId,
			userId,
			video,
			sourceKeyOverride,
			strictSourceKey,
		);
	} catch (error) {
		// Instant-mode recordings can be transcribed straight from their uploaded
		// audio segments when no muxed source exists (self-hosted deployments
		// without a media server never produce a result.mp4 at all).
		if (
			!sourceKeyOverride &&
			(video.source.type === "desktopSegments" ||
				video.source.type === "desktopMP4")
		) {
			const segments = await extractAudioFromSegmentsImpl(
				videoId,
				userId,
				video,
				tempAudioFilename,
			);
			if (segments.status === "ok") return segments.audioUrl;
			if (segments.status === "no-audio") return null;
			console.warn(
				`[transcribe] Segments audio fallback unavailable for ${videoId}: ${segments.reason}`,
			);
		}
		throw error;
	}

	let audioBuffer: Buffer | null;
	try {
		audioBuffer = await audioBufferFromSignedUrl(videoUrl, videoId);
	} catch (error) {
		try {
			videoUrl = await resolveVideoSourceUrl(
				videoId,
				userId,
				video,
				sourceKeyOverride,
				strictSourceKey,
			);
		} catch {
			throw error;
		}
		audioBuffer = await audioBufferFromSignedUrl(videoUrl, videoId);
	}
	if (!audioBuffer) return null;

	console.log(
		`[transcribe] Extracted audio for ${videoId}: ${audioBuffer.length} bytes`,
	);

	const audioKey = transcribeTempAudioKey(userId, videoId, tempAudioFilename);

	await bucket
		.putObject(audioKey, audioBuffer, {
			contentType: "audio/mpeg",
		})
		.pipe(runWorkflowPromise);

	const audioSignedUrl = await bucket
		.getInternalSignedObjectUrl(audioKey)
		.pipe(runWorkflowPromise);

	return audioSignedUrl;
}

function relocationState(value: string): RelocationState | null {
	switch (value) {
		case "INTENT":
		case "COPIED":
		case "POINTER":
		case "DELETED":
		case "PURGED":
		case "ABORTED":
			return value;
		default:
			return null;
	}
}

async function loadTranscribeSourceContext(videoId: string): Promise<{
	liveKey: string | null;
	relocations: Array<{
		oldKey: string;
		newKey: string;
		state: RelocationState;
	}>;
}> {
	const live = await resolveLiveOriginal(videoId);
	try {
		const rows = await db()
			.select({
				oldKey: sourceRelocation.oldKey,
				newKey: sourceRelocation.newKey,
				state: sourceRelocation.state,
			})
			.from(sourceRelocation)
			.where(eq(sourceRelocation.videoId, videoId as Video.VideoId));
		const relocations = rows.flatMap((row) => {
			const state = relocationState(row.state);
			if (!state) return [];
			return [{ oldKey: row.oldKey, newKey: row.newKey, state }];
		});
		return { liveKey: live?.liveKey ?? null, relocations };
	} catch (error) {
		const record = error as {
			errno?: number;
			code?: string;
			cause?: { errno?: number; code?: string };
		};
		if (
			record.errno === 1146 ||
			record.code === "ER_NO_SUCH_TABLE" ||
			record.cause?.errno === 1146 ||
			record.cause?.code === "ER_NO_SUCH_TABLE"
		) {
			return { liveKey: live?.liveKey ?? null, relocations: [] };
		}
		throw error;
	}
}

async function resolveVideoSourceUrl(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	sourceKeyOverride?: string,
	strictSourceKey = false,
): Promise<string> {
	const [resolvedBucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);

	const upload = await db()
		.select({ rawFileKey: videoUploads.rawFileKey })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId))
		.limit(1);
	const located = await loadTranscribeSourceContext(videoId);
	const candidateKeys =
		strictSourceKey && sourceKeyOverride
			? [sourceKeyOverride]
			: transcribeSourceCandidateKeys({
					userId,
					videoId,
					sourceKeyOverride,
					rawFileKey: upload[0]?.rawFileKey,
					liveKey: located.liveKey,
					relocations: located.relocations,
				});

	for (const key of candidateKeys) {
		const url = await resolvedBucket
			.getInternalSignedObjectUrl(key)
			.pipe(runWorkflowPromise);
		const response = await fetch(url, {
			method: "GET",
			headers: { range: "bytes=0-0" },
		});

		if (response.ok) {
			console.log(`[transcribe] Using video source ${key}`);
			return url;
		}
	}

	throw new Error("Video file not accessible");
}

type SegmentsAudioExtraction =
	| { status: "ok"; audioUrl: string; durationMs: number }
	| { status: "no-audio" }
	| { status: "unavailable"; reason: string };

async function extractAudioFromSegmentsStep(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
): Promise<SegmentsAudioExtraction> {
	"use step";

	return extractAudioFromSegmentsImpl(videoId, userId, video);
}

/**
 * Build the transcription audio input straight from the recording's uploaded
 * fMP4 audio segments (init.mp4 + segment_*.m4s byte-concatenate into a valid
 * fragmented MP4). Never throws: any failure reports "unavailable" so callers
 * can fall back to the muxed result.mp4 path instead of erroring the video.
 */
async function extractAudioFromSegmentsImpl(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	tempAudioFilename = "audio-temp.mp3",
): Promise<SegmentsAudioExtraction> {
	try {
		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runWorkflowPromise);

		const segSource = new Video.SegmentsSource({
			videoId,
			ownerId: video.ownerId,
		});

		const manifestContent = await bucket
			.getObject(segSource.getManifestKey())
			.pipe(runWorkflowPromise);
		const manifestJson = Option.getOrNull(manifestContent);
		if (!manifestJson) {
			return { status: "unavailable", reason: "segment manifest not found" };
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(manifestJson);
		} catch {
			return { status: "unavailable", reason: "invalid segment manifest JSON" };
		}

		const decoded = Schema.decodeUnknownEither(Video.SegmentManifest)(parsed);
		if (Either.isLeft(decoded)) {
			return {
				status: "unavailable",
				reason: "invalid segment manifest format",
			};
		}
		const manifest = decoded.right;

		const plan = planSegmentsAudioExtraction(manifest);
		if (plan.status !== "ok") return plan;

		const segmentUrls = await Promise.all([
			bucket
				.getInternalSignedObjectUrl(segSource.getAudioInitKey())
				.pipe(runWorkflowPromise),
			...plan.entries.map((entry) =>
				bucket
					.getInternalSignedObjectUrl(segSource.getAudioSegmentKey(entry.index))
					.pipe(runWorkflowPromise),
			),
		]);

		const concatPath = join(tmpdir(), `segments-audio-${randomUUID()}.mp4`);
		try {
			const totalBytes = await downloadConcatenatedSegments(
				segmentUrls,
				concatPath,
			);
			console.log(
				`[transcribe] Assembled ${plan.entries.length} audio segments (${totalBytes} bytes) for ${videoId}`,
			);

			// The concatenated init + fragments form a valid fragmented MP4 that
			// AssemblyAI ingests directly — no transcode, and no ffmpeg binary
			// (which is not available in the serverless runtime). The temp object
			// keeps the same key regardless of container so cleanupTempAudio's
			// contract is untouched.
			const audioBuffer = await fs.readFile(concatPath);

			const audioKey = transcribeTempAudioKey(
				userId,
				videoId,
				tempAudioFilename,
			);
			await bucket
				.putObject(audioKey, audioBuffer, {
					contentType: "audio/mp4",
				})
				.pipe(runWorkflowPromise);

			const audioSignedUrl = await bucket
				.getInternalSignedObjectUrl(audioKey)
				.pipe(runWorkflowPromise);

			return {
				status: "ok",
				audioUrl: audioSignedUrl,
				durationMs: plan.totalDurationMs,
			};
		} finally {
			await fs.unlink(concatPath).catch(() => {});
		}
	} catch (error) {
		return {
			status: "unavailable",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function submitSpeakerLabeledTranscription(
	audioUrl: string,
	language: AiGenerationLanguage,
	source?: SpeakerLabelSource,
	reservationToken?: string,
): Promise<string> {
	"use step";
	if (!source) {
		throw new FatalError("Speaker-label source binding required");
	}
	const existing = await loadSpeakerLabelClaim(source.videoId);
	if (existing?.state === "accepted") {
		const accepted = await reserveSpeakerLabelSubmit(
			source,
			language,
			reservationToken,
		);
		if (!accepted.submit && accepted.claim.transcriptId) {
			return accepted.claim.transcriptId;
		}
	}

	const audioResponse = await fetch(audioUrl);
	if (!audioResponse.ok) {
		throw new Error("Speaker-labeled transcription audio is unavailable");
	}
	const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
	const client = new AssemblyAI({
		apiKey: serverEnv().ASSEMBLY_API_KEY as string,
	});
	const reserved = await reserveSpeakerLabelSubmit(
		source,
		language,
		reservationToken,
	);
	if (!reserved.submit && reserved.claim.transcriptId) {
		return reserved.claim.transcriptId;
	}
	try {
		const transcript = await client.transcripts.submit({
			audio: audioBuffer,
			...getAssemblyAITranscriptionOptions(language),
			disfluencies: true,
			speaker_labels: true,
		});
		if (typeof transcript.id !== "string" || !transcript.id) {
			throw new Error("Missing transcript ID");
		}
		await persistSpeakerLabelId(reserved.claim, transcript.id);
		return transcript.id;
	} catch {
		throw new FatalError(
			"Speaker-labeled submission outcome unknown; do not resubmit",
		);
	}
}

submitSpeakerLabeledTranscription.maxRetries = 3;

export async function pollSpeakerLabeledTranscription(
	transcriptId: string,
	videoDurationMs: number,
	videoId: string,
): Promise<TranscriptionArtifacts> {
	"use step";

	const claim = await loadSpeakerLabelClaim(videoId);
	if (
		!claim ||
		claim.state !== "accepted" ||
		claim.transcriptId !== transcriptId
	) {
		throw new FatalError("Speaker-label accepted ID requires reconciliation");
	}
	await assertSpeakerLabelSource(claim);
	const transcript = await pollSpeakerLabelTranscript(claim);
	if (transcript.id !== transcriptId) {
		throw new FatalError("Speaker-labeled transcript ID mismatch");
	}
	if (transcript.status === "error") {
		throw new FatalError(
			`AssemblyAI transcription failed (id=${transcriptId}): ${transcript.error ?? "Unknown error"}`,
		);
	}
	if (transcript.status !== "completed") {
		throw new FatalError("Speaker-labeled transcript is not completed");
	}
	const durationMs =
		videoDurationMs > 0
			? videoDurationMs
			: (transcript.audio_duration ?? 0) * 1000;
	const editTranscript = createEditTranscript(transcript, durationMs);
	return {
		vtt: editTranscriptWordsToCaptionVtt(editTranscript.words),
		editTranscript: serializeEditTranscript(editTranscript),
		speakerLabelClaim: claim,
	};
}

async function transcribeWithAssemblyAI(
	audioUrl: string,
	language: AiGenerationLanguage,
	videoDurationMs: number,
	videoId?: string,
): Promise<TranscriptionArtifacts> {
	"use step";
	if (videoId) await assertNoSpeakerLabelClaim(videoId);

	const audioResponse = await fetch(audioUrl);
	if (!audioResponse.ok) {
		throw new Error(
			`Audio URL not accessible: ${audioResponse.status} ${audioResponse.statusText}`,
		);
	}

	const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
	const client = new AssemblyAI({
		apiKey: serverEnv().ASSEMBLY_API_KEY as string,
	});

	const transcript = await client.transcripts.transcribe(
		{
			audio: audioBuffer,
			...getAssemblyAITranscriptionOptions(language),
			disfluencies: true,
		},
		{ pollingInterval: 1000 },
	);

	console.log(
		`[transcribe] AssemblyAI transcript ${transcript.id} finished with status=${transcript.status}, model=${transcript.speech_model_used ?? "unknown"}`,
	);

	if (transcript.status === "error") {
		const transcriptError = transcript.error ?? "Unknown error";
		const message = `AssemblyAI transcription failed (id=${transcript.id}, language=${language}): ${transcriptError}`;

		if (transcriptError.toLowerCase().includes("no spoken audio")) {
			throw new FatalError(message);
		}

		throw new Error(message);
	}

	// One paid pass produces both artifacts: the immutable word transcript (in
	// the original media timeline) and the caption VTT derived from those words.
	const durationMs =
		videoDurationMs > 0
			? videoDurationMs
			: (transcript.audio_duration ?? 0) * 1000;
	const editTranscript = createEditTranscript(transcript, durationMs);

	return {
		vtt: editTranscriptWordsToCaptionVtt(editTranscript.words),
		editTranscript: serializeEditTranscript(editTranscript),
	};
}

async function transcribeEditTranscriptWithAssemblyAI(
	audioUrl: string,
	videoDurationSeconds: number,
	videoId?: string,
): Promise<string> {
	"use step";
	if (videoId) await assertNoSpeakerLabelClaim(videoId);

	const audioResponse = await fetch(audioUrl);
	if (!audioResponse.ok) {
		throw new Error(
			`Audio URL not accessible: ${audioResponse.status} ${audioResponse.statusText}`,
		);
	}

	const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
	const client = new AssemblyAI({
		apiKey: serverEnv().ASSEMBLY_API_KEY as string,
	});
	const transcript = await client.transcripts.transcribe({
		audio: audioBuffer,
		...getAssemblyAITranscriptionOptions("auto"),
		disfluencies: true,
	});

	console.log(
		`[transcribe] AssemblyAI editable transcript ${transcript.id} finished with status=${transcript.status}, model=${transcript.speech_model_used ?? "unknown"}`,
	);

	if (transcript.status === "error") {
		throw new Error(
			`AssemblyAI editable transcription failed (id=${transcript.id}): ${transcript.error ?? "Unknown error"}`,
		);
	}

	const durationMs =
		videoDurationSeconds > 0
			? videoDurationSeconds * 1000
			: (transcript.audio_duration ?? 0) * 1000;
	return serializeEditTranscript(createEditTranscript(transcript, durationMs));
}

async function saveTranscription(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	transcription: TranscriptionArtifacts,
): Promise<void> {
	"use step";
	if (transcription.speakerLabelClaim) {
		const current = await loadSpeakerLabelClaim(videoId);
		if (
			current?.token !== transcription.speakerLabelClaim.token ||
			current?.transcriptId !== transcription.speakerLabelClaim.transcriptId
		) {
			throw new FatalError("Speaker-label result is stale");
		}
		await assertSpeakerLabelSource(transcription.speakerLabelClaim);
	} else {
		await assertNoSpeakerLabelClaim(videoId);
	}

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);

	await bucket
		.putObject(`${userId}/${videoId}/transcription.vtt`, transcription.vtt, {
			contentType: "text/vtt",
		})
		.pipe(runWorkflowPromise);

	// The word transcript must always describe the ORIGINAL media. This pass ran
	// against whatever media is current, so it may only be persisted while the
	// video is un-edited; edited videos keep (or backfill) their own transcript.
	const [edit] = await db()
		.select({ videoId: videoEdits.videoId })
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId as Video.VideoId));

	if (edit) {
		console.log(
			`[transcribe] Skipping edit transcript write for edited video ${videoId}`,
		);
	} else {
		await bucket
			.putObject(
				getEditTranscriptObjectKey(userId, videoId),
				encryptEditTranscriptObject(
					transcription.editTranscript,
					userId,
					videoId,
				),
				{ contentType: "application/octet-stream" },
			)
			.pipe(runWorkflowPromise);
	}

	const { enqueueSourceCaptionsAfterTranscript } = await import(
		"@/lib/source-prepare-worker"
	);
	await db().transaction(async (tx) => {
		await tx
			.update(videos)
			.set({ transcriptionStatus: "COMPLETE" })
			.where(eq(videos.id, videoId as Video.VideoId));
		await enqueueSourceCaptionsAfterTranscript(tx, videoId);
	});

	// The canonical transcript supersedes the provisional live transcript, so
	// drop the artifact and its metadata flag. Never fatal: a leftover live
	// artifact is unused once transcriptionStatus is COMPLETE.
	if (
		video.source.type === "desktopSegments" ||
		video.source.type === "desktopMP4"
	) {
		try {
			await bucket
				.deleteObject(getLiveTranscriptObjectKey(userId, videoId))
				.pipe(runWorkflowPromise);
		} catch (error) {
			console.warn(
				`[transcribe] Failed to clean up live transcript for ${videoId}`,
				error,
			);
		}
		await clearLiveTranscriptFlag(videoId);
	}
}

async function saveEditTranscriptBackfill(
	videoId: string,
	userId: string,
	requestId: string,
	video: typeof videos.$inferSelect,
	editTranscript: string,
) {
	"use step";

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);

	if (!(await canPersistEditTranscriptBackfill(videoId, requestId, video)))
		return;

	await bucket
		.putObject(
			getEditTranscriptObjectKey(userId, videoId),
			encryptEditTranscriptObject(editTranscript, userId, videoId),
			{
				contentType: "application/octet-stream",
			},
		)
		.pipe(runWorkflowPromise);
	await clearEditTranscriptBackfill(videoId, requestId);
}

async function saveEditTranscriptBackfillError(
	videoId: string,
	requestId: string,
	video: typeof videos.$inferSelect,
) {
	"use step";

	if (!(await canPersistEditTranscriptBackfill(videoId, requestId, video)))
		return;

	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.editTranscriptBackfill.status', 'error')`,
			updatedAt: sql`${videos.updatedAt}`,
		})
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.editTranscriptBackfill.requestId')) = ${requestId}`,
			),
		);
}

async function canPersistEditTranscriptBackfill(
	videoId: string,
	requestId: string,
	video: typeof videos.$inferSelect,
) {
	const [[currentVideo], [activeUpload]] = await Promise.all([
		db()
			.select({
				duration: videos.duration,
				metadata: videos.metadata,
				transcriptionStatus: videos.transcriptionStatus,
				updatedAt: videos.updatedAt,
			})
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId)),
		db()
			.select({ phase: videoUploads.phase })
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId as Video.VideoId))
			.limit(1),
	]);

	return (
		currentVideo?.transcriptionStatus === "COMPLETE" &&
		currentVideo.duration === video.duration &&
		currentVideo.updatedAt.getTime() === video.updatedAt.getTime() &&
		getEditTranscriptBackfillStatus(currentVideo.metadata)?.requestId ===
			requestId &&
		!activeUpload
	);
}

async function clearEditTranscriptBackfill(videoId: string, requestId: string) {
	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_REMOVE(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.editTranscriptBackfill')`,
			updatedAt: sql`${videos.updatedAt}`,
		})
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.editTranscriptBackfill.requestId')) = ${requestId}`,
			),
		);
}

async function cleanupTempAudio(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	tempAudioFilename = "audio-temp.mp3",
): Promise<void> {
	"use step";

	const audioKey = transcribeTempAudioKey(userId, videoId, tempAudioFilename);

	try {
		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runWorkflowPromise);

		await bucket.deleteObject(audioKey).pipe(runWorkflowPromise);
	} catch (error) {
		console.error(
			`[transcribe] Failed to cleanup temp audio file: ${audioKey}`,
			error,
		);
	}
}

async function queueAiGeneration(
	videoId: string,
	userId: string,
): Promise<void> {
	"use step";

	await startAiGeneration(videoId as Video.VideoId, userId);
}

async function _markEnhancedAudioProcessing(videoId: string): Promise<void> {
	"use step";

	const [video] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	const currentMetadata = (video?.metadata as VideoMetadata) || {};

	await db()
		.update(videos)
		.set({
			metadata: {
				...currentMetadata,
				enhancedAudioStatus: "PROCESSING",
			},
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function _enhanceAndSaveAudio(
	videoId: string,
	userId: string,
	audioUrl: string,
	video: typeof videos.$inferSelect,
): Promise<void> {
	"use step";

	console.log(`[transcribe] Starting audio enhancement for video ${videoId}`);

	try {
		const enhancedBuffer = await enhanceAudioFromUrl(audioUrl);
		console.log(
			`[transcribe] Audio enhanced, saving to S3 (${enhancedBuffer.length} bytes)`,
		);

		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runWorkflowPromise);

		const enhancedAudioKey = `${userId}/${videoId}/enhanced-audio.${ENHANCED_AUDIO_EXTENSION}`;

		await bucket
			.putObject(enhancedAudioKey, enhancedBuffer, {
				contentType: ENHANCED_AUDIO_CONTENT_TYPE,
			})
			.pipe(runWorkflowPromise);

		const [videoRecord] = await db()
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));

		const currentMetadata = (videoRecord?.metadata as VideoMetadata) || {};

		await db()
			.update(videos)
			.set({
				metadata: {
					...currentMetadata,
					enhancedAudioStatus: "COMPLETE",
				},
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	} catch (error) {
		console.error(
			`[transcribe] Audio enhancement failed for video ${videoId}:`,
			error,
		);

		const [video] = await db()
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));

		const currentMetadata = (video?.metadata as VideoMetadata) || {};

		await db()
			.update(videos)
			.set({
				metadata: {
					...currentMetadata,
					enhancedAudioStatus: "ERROR",
				},
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	}
}

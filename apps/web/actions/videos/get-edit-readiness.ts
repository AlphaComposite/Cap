"use server";

import { createHash } from "node:crypto";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	editRevision,
	organizations,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import { Storage } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { getEditTranscript } from "@/actions/videos/get-edit-transcript";
import { loadEligibleLegacy } from "@/lib/flagged-unedited";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import { readArtifactReady, readPublication } from "@/lib/revision-media-grant";
import { runPromise } from "@/lib/server";
import {
	deriveEditReadiness,
	type EditReadiness,
	publicationAdmitsPlayback,
	type TranscriptReadState,
	type VideoPreparationState,
} from "@/lib/video-edit-readiness";

export type EditReadinessResult =
	| { status: "ready"; readiness: EditReadiness }
	| { status: "unavailable" };

async function readFacts(videoId: Video.VideoId, ownerId: string) {
	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));
	if (!video || video.ownerId !== ownerId) return null;
	const [organization] =
		video.orgId && video.transcriptionStatus === null
			? await db()
					.select({ settings: organizations.settings })
					.from(organizations)
					.where(eq(organizations.id, video.orgId))
			: [];
	const transcriptAvailable =
		Boolean(serverEnv().ASSEMBLY_API_KEY) &&
		!(
			video.settings?.disableTranscript ??
			organization?.settings?.disableTranscript ??
			false
		);
	const [upload] = await db()
		.select()
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId));
	const eligible =
		!video.isScreenshot &&
		["webMP4", "desktopMP4"].includes(video.source.type) &&
		Boolean(video.duration && video.duration > 0);
	const videoState: VideoPreparationState = upload?.processingError
		? "failed"
		: upload?.phase === "uploading"
			? "uploading"
			: upload?.phase === "processing" ||
					upload?.phase === "generating_thumbnail"
				? "processing"
				: upload?.phase === "error"
					? "failed"
					: eligible && !video.metadata?.editProcessing
						? "processed"
						: "unavailable";
	let playbackAdmission = false;
	let legacyAdmission = false;
	let publicationIdentity: unknown = null;
	if (isInstantFinishEnabledForOwner(video.ownerId)) {
		const publication = await readPublication(videoId);
		publicationIdentity = publication;
		if (
			publication &&
			publication !== "missing_table" &&
			publication.currentRevisionId
		) {
			const [revision] = await db()
				.select()
				.from(editRevision)
				.where(eq(editRevision.revisionId, publication.currentRevisionId));
			const artifacts = await Promise.all(
				["playlist", "init", "seg0"].map((artifact) =>
					readArtifactReady(publication.currentRevisionId as string, artifact),
				),
			);
			publicationIdentity = { publication, revision, artifacts };
			playbackAdmission = Boolean(
				revision &&
					publicationAdmitsPlayback({
						videoId,
						revisionVideoId: revision.videoId,
						currentRevisionId: publication.currentRevisionId,
						revisionId: revision.revisionId,
						currentGeneration: publication.currentGeneration,
						revisionGeneration: revision.generation,
						publicationEpoch: publication.publicationEpoch,
						policyEpoch: publication.policyEpoch,
						revisionState: revision.state,
						bucket: video.bucket,
						artifacts,
					}),
			);
		} else if (publication !== "missing_table") {
			legacyAdmission = await loadEligibleLegacy({
				videoId,
				ownerId: video.ownerId,
			});
		}
	} else {
		legacyAdmission = true;
	}
	if (legacyAdmission && eligible && videoState === "processed") {
		playbackAdmission = await Effect.gen(function* () {
			const loadedVideo = yield* Schema.decodeUnknown(Video.Video)({
				...video,
				bucketId: video.bucket,
				createdAt: video.createdAt.toISOString(),
				updatedAt: video.updatedAt.toISOString(),
			});
			const [access] = yield* Storage.getAccessForVideo(loadedVideo);
			const metadata = yield* access.headObject(
				`${video.ownerId}/${videoId}/result.mp4`,
			);
			return Boolean(metadata.ContentLength && metadata.ContentLength > 0);
		})
			.pipe(runPromise)
			.catch(() => false);
	}
	playbackAdmission =
		playbackAdmission &&
		eligible &&
		videoState === "processed" &&
		Boolean(
			video.width &&
				video.width > 0 &&
				video.height &&
				video.height > 0 &&
				video.fps &&
				video.fps > 0,
		);
	const identity = createHash("sha256")
		.update(
			JSON.stringify({
				video,
				upload,
				publicationIdentity,
				playbackAdmission,
				transcriptAvailable,
			}),
		)
		.digest("hex");
	return {
		video,
		eligible,
		videoState,
		playbackAdmission,
		identity,
		transcriptAvailable,
	};
}

export async function getEditReadiness(
	videoId: Video.VideoId,
): Promise<EditReadinessResult> {
	try {
		const user = await getCurrentUser();
		if (!user) return { status: "unavailable" };
		const facts = await readFacts(videoId, user.id);
		if (!facts) return { status: "unavailable" };
		const isPro = userIsPro(user);
		let transcriptRead: TranscriptReadState = "unavailable";
		if (
			facts.eligible &&
			isPro &&
			facts.video.transcriptionStatus === "COMPLETE"
		) {
			const transcript = await getEditTranscript(videoId);
			if (transcript.status === "ready")
				transcriptRead =
					transcript.transcript.words.length === 0 ? "empty" : "ready";
			else if (transcript.status === "processing")
				transcriptRead = "processing";
		}
		const fresh = await readFacts(videoId, user.id);
		if (!fresh || fresh.identity !== facts.identity)
			return { status: "unavailable" };
		return {
			status: "ready",
			readiness: deriveEditReadiness({
				videoId,
				identity: facts.identity,
				eligible: facts.eligible,
				isPro,
				playbackAdmission: facts.playbackAdmission,
				videoState: facts.videoState,
				transcriptionStatus:
					!facts.transcriptAvailable && facts.video.transcriptionStatus === null
						? "UNAVAILABLE"
						: facts.video.transcriptionStatus,
				transcriptRead,
			}),
		};
	} catch {
		return { status: "unavailable" };
	}
}

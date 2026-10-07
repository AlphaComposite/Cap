"use server";

import { createHash } from "node:crypto";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	editRevision,
	organizations,
	sourceObject,
	sourceRelocation,
	videoEdits,
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
import { isAiConfigured } from "@/lib/ai/provider";
import { loadEligibleLegacy } from "@/lib/flagged-unedited";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import { resolveLiveOriginal } from "@/lib/private-source-read";
import { readArtifactReady, readPublication } from "@/lib/revision-media-grant";
import { readEditorPreparation } from "@/lib/revision-publication-read";
import { runPromise } from "@/lib/server";
import {
	assertFinishSourceKey,
	inventoryExposedKeys,
} from "@/lib/source-relocation";
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

const SHA256 = /^[a-f0-9]{64}$/;

function finitePositive(value: unknown) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function registeredPrivateKey(videoId: string, key: string) {
	const prefix = `private/source/${videoId}/`;
	return (
		key.startsWith(prefix) &&
		key.length > prefix.length &&
		!key.includes("..") &&
		!key.includes("*") &&
		!key.includes("?") &&
		!key.includes("\\") &&
		!key.includes("://")
	);
}

type OwnerSourceIdentity = {
	videoId: string;
	liveKey: string | null;
	sha256: string | null;
	relocationState: string | null;
	relocationCount: number;
	selectedOriginal: string | null;
	verified: boolean;
};

type RelocationRow = {
	videoId?: string;
	oldKey?: string;
	newKey?: string;
	sha256?: string;
	state?: string;
};

function ownerScopedObjectKey(ownerId: string, videoId: string, key: string) {
	const prefix = `${ownerId}/${videoId}/`;
	return (
		key.startsWith(prefix) &&
		key.length > prefix.length &&
		!key.includes("..") &&
		!key.includes("*") &&
		!key.includes("?") &&
		!key.includes("\\") &&
		!key.includes("://")
	);
}

function rollbackDestination(videoId: string, key: string) {
	const prefix = `private/rollback/${videoId}/`;
	return (
		key.startsWith(prefix) &&
		key.length > prefix.length &&
		!key.includes("..") &&
		!key.includes("*") &&
		!key.includes("?") &&
		!key.includes("\\") &&
		!key.includes("://")
	);
}

function fixedRollbackObject(ownerId: string, videoId: string, key: string) {
	const prefix = `${ownerId}/${videoId}/`;
	return (
		key === `${prefix}result.mp4` ||
		key === `${prefix}screenshot/screen-capture.jpg` ||
		key === `${prefix}screenshot.jpg` ||
		key === `${prefix}preview/animated-preview.gif`
	);
}

function originalProvenance(
	ownerId: string,
	videoId: string,
	sourceKey: string | undefined,
) {
	const exposed = inventoryExposedKeys({ ownerId, videoId, sourceKey });
	const keys = new Set<string>();
	for (const item of exposed) {
		if (item.kind !== "original") continue;
		if (!ownerScopedObjectKey(ownerId, videoId, item.key)) continue;
		if (fixedRollbackObject(ownerId, videoId, item.key)) continue;
		keys.add(item.key);
	}
	return keys;
}

function classifyRelocation(
	row: RelocationRow,
	videoId: string,
	ownerId: string,
	provenance: ReadonlySet<string>,
	liveKey: string | null,
	liveSha: string | null,
	sourceType: string,
): "match" | "unrelated" | "conflict" {
	if (String(row.videoId ?? "") !== videoId) return "conflict";
	if (!row.oldKey || !row.newKey || !row.sha256 || !row.state)
		return "conflict";
	if (row.oldKey.includes("://") || row.newKey.includes("://"))
		return "conflict";
	if (!ownerScopedObjectKey(ownerId, videoId, row.oldKey)) return "conflict";
	const sourceDestination = registeredPrivateKey(videoId, row.newKey);
	const rollback = rollbackDestination(videoId, row.newKey);
	if (!sourceDestination && !rollback) return "conflict";
	const originalClass =
		provenance.has(row.oldKey) ||
		row.newKey === liveKey ||
		sourceDestination ||
		row.oldKey.includes("/source/");
	if (
		!originalClass &&
		rollback &&
		row.newKey !== liveKey &&
		SHA256.test(row.sha256)
	) {
		return "unrelated";
	}
	// webMP4's relocated original is exactly result.mp4. Keep that key out of originalProvenance so rollback rows stay unrelated.
	const webOriginal =
		sourceType === "webMP4" ? `${ownerId}/${videoId}/result.mp4` : null;
	if (
		liveKey &&
		liveSha &&
		(provenance.has(row.oldKey) ||
			(row.oldKey === webOriginal && row.newKey === liveKey)) &&
		row.newKey === liveKey &&
		row.sha256 === liveSha &&
		row.state === "PURGED" &&
		SHA256.test(liveSha) &&
		registeredPrivateKey(videoId, liveKey)
	) {
		return "match";
	}
	return "conflict";
}

function selectedOriginalIdentity(rows: RelocationRow[]) {
	if (rows.length === 0) return null;
	return rows
		.map((row) =>
			[
				row.videoId ?? "",
				row.oldKey ?? "",
				row.newKey ?? "",
				row.sha256 ?? "",
				row.state ?? "",
			].join("\u0001"),
		)
		.sort()
		.join("\n");
}

// Do not call ownerOriginalObjectKey: it falls back to an unregistered path and maps non-PURGED states.
// Per-video journals also store result/rollback objects, so admission is the unique original row, not row count.
async function readOwnerPrivateSource(
	videoId: Video.VideoId,
	ownerId: string,
	sourceType: string,
): Promise<{
	identity: OwnerSourceIdentity;
	key: string | null;
}> {
	const identity: OwnerSourceIdentity = {
		videoId,
		liveKey: null,
		sha256: null,
		relocationState: null,
		relocationCount: 0,
		selectedOriginal: null,
		verified: false,
	};
	try {
		const live = await resolveLiveOriginal(videoId);
		const sources = (await db()
			.select()
			.from(sourceObject)
			.where(eq(sourceObject.videoId, videoId))) as Array<{
			videoId?: string;
			liveKey?: string;
			sha256?: string;
			relocationState?: string;
		}>;
		const relocations = (await db()
			.select()
			.from(sourceRelocation)
			.where(eq(sourceRelocation.videoId, videoId))) as RelocationRow[];
		const edits = (await db()
			.select()
			.from(videoEdits)
			.where(eq(videoEdits.videoId, videoId))) as Array<{
			videoId?: string;
			sourceKey?: string;
		}>;
		const source = sources.length === 1 ? sources[0] : undefined;
		identity.liveKey = live?.liveKey ?? source?.liveKey ?? null;
		identity.sha256 = live?.sha256 ?? source?.sha256 ?? null;
		identity.relocationState = source?.relocationState ?? null;
		identity.relocationCount = relocations.length;
		const edit = edits.length === 1 ? edits[0] : undefined;
		if (edits.length > 1 || (edit && String(edit.videoId ?? "") !== videoId)) {
			identity.selectedOriginal = selectedOriginalIdentity(relocations);
			return { identity, key: null };
		}
		const provenance = originalProvenance(ownerId, videoId, edit?.sourceKey);
		const webOriginal =
			sourceType === "webMP4" ? `${ownerId}/${videoId}/result.mp4` : null;
		const classified = relocations.map((row) => ({
			row,
			decision: classifyRelocation(
				row,
				videoId,
				ownerId,
				provenance,
				live?.liveKey ?? null,
				live?.sha256 ?? null,
				sourceType,
			),
		}));
		identity.selectedOriginal = selectedOriginalIdentity(
			classified
				.filter((item) => item.decision !== "unrelated")
				.map((item) => item.row),
		);
		const matches = classified
			.filter((item) => item.decision === "match")
			.map((item) => item.row);
		const relocation = matches.length === 1 ? matches[0] : undefined;
		if (
			!live?.liveKey ||
			!live.sha256 ||
			!source?.liveKey ||
			!source.sha256 ||
			!relocation?.newKey ||
			!relocation.sha256 ||
			!relocation.state ||
			!relocation.oldKey ||
			sources.length !== 1 ||
			classified.some((item) => item.decision === "conflict") ||
			matches.length !== 1 ||
			String(source.videoId) !== videoId ||
			String(relocation.videoId) !== videoId ||
			source.relocationState !== "PURGED" ||
			relocation.state !== "PURGED" ||
			source.liveKey !== live.liveKey ||
			source.sha256 !== live.sha256 ||
			relocation.newKey !== live.liveKey ||
			relocation.sha256 !== live.sha256 ||
			!(
				provenance.has(relocation.oldKey) ||
				(relocation.oldKey === webOriginal &&
					relocation.newKey === live.liveKey)
			) ||
			!SHA256.test(live.sha256) ||
			!registeredPrivateKey(videoId, live.liveKey)
		) {
			return { identity, key: null };
		}
		assertFinishSourceKey({
			liveKey: live.liveKey,
			relocations: [{ newKey: relocation.newKey, state: relocation.state }],
		});
		identity.verified = true;
		return { identity, key: live.liveKey };
	} catch {
		return { identity, key: null };
	}
}

async function objectHasPositiveLength<
	T extends {
		bucket: unknown;
		createdAt: Date;
		updatedAt: Date;
	},
>(video: T, key: string) {
	return Effect.gen(function* () {
		const loadedVideo = yield* Schema.decodeUnknown(Video.Video)({
			...video,
			bucketId: video.bucket,
			createdAt: video.createdAt.toISOString(),
			updatedAt: video.updatedAt.toISOString(),
		});
		const [access] = yield* Storage.getAccessForVideo(loadedVideo);
		const metadata = yield* access.headObject(key);
		return (
			typeof metadata.ContentLength === "number" &&
			Number.isFinite(metadata.ContentLength) &&
			metadata.ContentLength > 0
		);
	})
		.pipe(runPromise)
		.catch(() => false);
}

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
	let sourceIdentity: OwnerSourceIdentity | null = null;
	let ownerSourceKey: string | null = null;
	const flagged = isInstantFinishEnabledForOwner(video.ownerId);
	const editorPreparation = flagged
		? await readEditorPreparation(db(), videoId)
		: null;
	if (flagged) {
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
			const ownerSource = await readOwnerPrivateSource(
				videoId,
				video.ownerId,
				video.source.type,
			);
			sourceIdentity = ownerSource.identity;
			ownerSourceKey = ownerSource.key;
		}
	} else {
		legacyAdmission = true;
	}
	if (legacyAdmission && eligible && videoState === "processed") {
		playbackAdmission = await objectHasPositiveLength(
			video,
			`${video.ownerId}/${videoId}/result.mp4`,
		);
	}
	const geometryReady =
		finitePositive(video.duration) &&
		finitePositive(video.width) &&
		finitePositive(video.height) &&
		finitePositive(video.fps);
	if (
		!playbackAdmission &&
		ownerSourceKey &&
		eligible &&
		videoState === "processed" &&
		geometryReady
	) {
		playbackAdmission = await objectHasPositiveLength(video, ownerSourceKey);
	}
	playbackAdmission =
		playbackAdmission &&
		eligible &&
		videoState === "processed" &&
		geometryReady;
	const identity = createHash("sha256")
		.update(
			JSON.stringify({
				video,
				upload,
				publicationIdentity,
				sourceIdentity,
				playbackAdmission,
				transcriptAvailable,
				editorPreparation,
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
		editorPreparation,
		upload,
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
				editorOpenable:
					facts.editorPreparation?.editorOpenable ??
					!isInstantFinishEnabledForOwner(facts.video.ownerId),
				uploadPhase: facts.upload?.phase ?? null,
				processingError: facts.upload?.processingError,
				canRetryProcessing: Boolean(facts.upload?.rawFileKey),
				aiGenerationStatus:
					facts.video.metadata?.aiGenerationStatus ??
					(isPro &&
					isAiConfigured() &&
					facts.transcriptAvailable &&
					!["SKIPPED", "NO_AUDIO", "ERROR"].includes(
						facts.video.transcriptionStatus ?? "",
					)
						? "QUEUED"
						: "UNAVAILABLE"),
				sourcePrepare: facts.editorPreparation?.sourcePrepare,
				sourcePrepareError: facts.editorPreparation?.reason,
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

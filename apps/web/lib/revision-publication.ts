import { randomBytes } from "node:crypto";
import type { db } from "@cap/database";
import {
	comments,
	editIntent,
	editRevision,
	revisionArtifactStatus,
	revisionOutbox,
	sourceObject,
	videoEdits,
	videoPublication,
	videos,
} from "@cap/database/schema";
import type { VideoEditSpec, VideoEditSpecV2 } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, lt, sql } from "drizzle-orm";
import type { EditTranscript } from "@/lib/edit-transcript";
import {
	assertServableEncoderProfile,
	chaptersDocument,
	deriveRevisionCaptions,
	deriveRevisionChapters,
	ENCODER_PROFILE,
	intentIdFor,
	MAPPING_VERSION,
	OUTBOX_JOBS,
	playlistDurationSeconds,
	previousEditionSpec,
	RevisionPublicationError,
	remapCommentTimestamp,
	requireV2Spec,
	type SourceIdentity,
	sourceIdFromIdentity,
	thumbnailBindsDuration,
} from "@/lib/revision-publication-metadata";
import { bumpPolicyEpoch } from "@/lib/revision-media-grant";
import {
	digestMatches,
	type OriginClient,
} from "@/lib/revision-publication-origin";

export type { InstantFinishPublicationDto as RevisionPublicationDto } from "@/lib/revision-publication-read";
export {
	disabledInstantFinishPublication as disabledRevisionPublication,
	getInstantFinishPublicationDto as getRevisionPublication,
} from "@/lib/revision-publication-read";
import {
	areEditSpecDocumentsEquivalent,
	getEditSpecOutputDuration,
	type VideoChapter,
} from "@/lib/video-edits";

export { RevisionPublicationError } from "@/lib/revision-publication-metadata";

type Database = ReturnType<typeof db>;
type PublicationTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const LEGAL: Record<string, readonly string[]> = {
	COMMITTED_INTENT: ["PREPARING", "SUPERSEDED"],
	PREPARING: ["READY", "SUPERSEDED", "FAILED"],
	READY: ["PUBLISHING", "SUPERSEDED"],
	PUBLISHING: ["CURRENT", "FAILED"],
	CURRENT: [],
	SUPERSEDED: [],
	FAILED: [],
};

export type PublishRevisionInput = {
	videoId: string;
	editSpec: VideoEditSpec;
	expectedEditSpec?: VideoEditSpec | null;
	baseGeneration: number;
	draftVersion: number;
	draftSession: string;
	chapters?: readonly VideoChapter[];
	transcript?: EditTranscript | null;
	sourceDuration?: number | null;
};

export type PublishRevisionDeps = {
	origin: OriginClient;
	now?: () => Date;
	randomRevisionId?: () => string;
	onAllocated?: (allocated: {
		revisionId: string;
		generation: number;
		intentId: string;
	}) => Promise<void>;
};

export type PublishRevisionSuccess = {
	success: true;
	revisionId: string;
	generation: number;
};

function affectedRows(result: unknown): number {
	if (Array.isArray(result)) {
		const header = result[0] as { affectedRows?: number } | undefined;
		return header?.affectedRows ?? 0;
	}
	if (result && typeof result === "object" && "affectedRows" in result) {
		return Number((result as { affectedRows: number }).affectedRows);
	}
	return 0;
}

function videoId(value: string): Video.VideoId {
	return value as Video.VideoId;
}

function newRevisionId(intentId: string): string {
	const revisionId = randomBytes(32).toString("hex");
	if (revisionId === intentId) {
		throw new RevisionPublicationError(
			500,
			"Revision id collided with intent id",
		);
	}
	return revisionId;
}

export async function publishInstantFinishRevision(
	database: unknown,
	input: PublishRevisionInput,
	deps: PublishRevisionDeps,
): Promise<PublishRevisionSuccess> {
	const app = database as Database;
	const spec = requireV2Spec(input.editSpec);
	assertServableEncoderProfile(ENCODER_PROFILE);
	const now = deps.now ?? (() => new Date());
	const mintRevisionId = deps.randomRevisionId ?? newRevisionId;
	const allocated = await app.transaction(async (tx) =>
		allocateRevision(tx, input, spec, now(), mintRevisionId),
	);
	if (allocated.idempotent) {
		return {
			success: true,
			revisionId: allocated.revisionId,
			generation: allocated.generation,
		};
	}
	try {
		if (deps.onAllocated) await deps.onAllocated(allocated);
		await transition(app, allocated.revisionId, "PREPARING", now());
		const prepared = await produceAndVerify(
			input,
			spec,
			allocated,
			deps.origin,
		);
		await transition(app, allocated.revisionId, "READY", now());
		await transition(app, allocated.revisionId, "PUBLISHING", now());
		await app.transaction(async (tx) => {
			await flipCurrent(tx, input, spec, allocated, prepared, now());
		});
		return {
			success: true,
			revisionId: allocated.revisionId,
			generation: allocated.generation,
		};
	} catch (error) {
		await failOpenRevision(app, allocated.revisionId, error, now());
		if (error instanceof RevisionPublicationError) throw error;
		throw new RevisionPublicationError(
			500,
			error instanceof Error ? error.message : "Revision publication failed",
			allocated.generation,
			allocated.revisionId,
		);
	}
}

type Allocated = {
	idempotent: boolean;
	revisionId: string;
	generation: number;
	intentId: string;
	sourceId: string;
	previousSpec: VideoEditSpec;
};

async function allocateRevision(
	tx: PublicationTx,
	input: PublishRevisionInput,
	spec: VideoEditSpecV2,
	stamp: Date,
	mintRevisionId: (intentId: string) => string,
): Promise<Allocated> {
	await tx
		.select({ id: videos.id })
		.from(videos)
		.where(eq(videos.id, videoId(input.videoId)))
		.for("update");
	await tx
		.insert(videoPublication)
		.values({ videoId: videoId(input.videoId) })
		.onDuplicateKeyUpdate({ set: { videoId: videoId(input.videoId) } });
	const [publication] = await tx
		.select()
		.from(videoPublication)
		.where(eq(videoPublication.videoId, videoId(input.videoId)))
		.for("update");
	if (!publication) {
		throw new RevisionPublicationError(500, "Publication row was not created");
	}
	if (
		input.draftVersion < publication.latestDraftVersion &&
		publication.draftSession === input.draftSession
	) {
		throw new RevisionPublicationError(
			409,
			`draftVersion ${input.draftVersion} is older than ${publication.latestDraftVersion}`,
			publication.generation,
		);
	}
	if (input.baseGeneration !== publication.generation) {
		throw new RevisionPublicationError(
			409,
			`generation ${input.baseGeneration} != ${publication.generation}`,
			publication.generation,
		);
	}
	const identity = await readReadySource(tx, input.videoId, stamp);
	const sourceId = sourceIdFromIdentity(identity);
	const intentId = intentIdFor({
		sourceId,
		spec,
		mappingVersion: MAPPING_VERSION,
		profile: ENCODER_PROFILE,
	});
	const previous = await readPreviousSpec(tx, input, spec);
	if (
		input.expectedEditSpec &&
		!areEditSpecDocumentsEquivalent(
			previous.previousSpec,
			input.expectedEditSpec,
		)
	) {
		throw new RevisionPublicationError(
			409,
			"This video was edited in another session. Reload before publishing.",
			publication.generation,
		);
	}
	const current = publication.currentRevisionId
		? await readRevision(tx, publication.currentRevisionId)
		: null;
	if (
		current &&
		current.state === "CURRENT" &&
		current.intentId === intentId &&
		current.generation === publication.generation
	) {
		await advanceDraft(tx, input, publication.latestDraftVersion);
		return {
			idempotent: true,
			revisionId: current.revisionId,
			generation: current.generation,
			intentId,
			sourceId,
			previousSpec: previous.previousSpec,
		};
	}
	const nextGeneration = publication.generation + 1;
	const updated = await tx
		.update(videoPublication)
		.set({ generation: nextGeneration })
		.where(
			and(
				eq(videoPublication.videoId, videoId(input.videoId)),
				eq(videoPublication.generation, publication.generation),
			),
		);
	if (affectedRows(updated) !== 1) {
		throw new RevisionPublicationError(
			409,
			"generation compare-and-set failed",
			publication.generation,
		);
	}
	await tx
		.update(editRevision)
		.set({ state: "SUPERSEDED", error: "superseded", updatedAt: stamp })
		.where(
			and(
				eq(editRevision.videoId, videoId(input.videoId)),
				lt(editRevision.generation, nextGeneration),
				sql`${editRevision.state} in ('COMMITTED_INTENT','PREPARING','READY')`,
			),
		);
	await tx.insert(editIntent).values({
		videoId: videoId(input.videoId),
		generation: nextGeneration,
		intentId,
		sourceId,
		canonicalSpec: spec,
		mappingVersion: MAPPING_VERSION,
		encoderProfile: ENCODER_PROFILE,
		draftVersion: input.draftVersion,
		draftSession: input.draftSession,
		createdAt: stamp,
	});
	const attempts = await tx
		.select({ revisionId: editRevision.revisionId })
		.from(editRevision)
		.where(eq(editRevision.intentId, intentId));
	const revisionId = mintRevisionId(intentId);
	await tx.insert(editRevision).values({
		revisionId,
		videoId: videoId(input.videoId),
		intentId,
		sourceId,
		generation: nextGeneration,
		state: "COMMITTED_INTENT",
		attempt: attempts.length + 1,
		error: null,
		createdAt: stamp,
		updatedAt: stamp,
	});
	await advanceDraft(tx, input, publication.latestDraftVersion);
	return {
		idempotent: false,
		revisionId,
		generation: nextGeneration,
		intentId,
		sourceId,
		previousSpec: previous.previousSpec,
	};
}

async function advanceDraft(
	tx: PublicationTx,
	input: PublishRevisionInput,
	latestDraftVersion: number,
) {
	if (input.draftVersion <= latestDraftVersion) return;
	await tx
		.update(videoPublication)
		.set({
			latestDraftVersion: input.draftVersion,
			draftSession: input.draftSession,
		})
		.where(eq(videoPublication.videoId, videoId(input.videoId)));
}

async function readReadySource(
	tx: PublicationTx,
	id: string,
	now: Date,
): Promise<SourceIdentity> {
	const [row] = await tx
		.select()
		.from(sourceObject)
		.where(eq(sourceObject.videoId, videoId(id)));
	if (
		!row?.liveKey ||
		!row.sha256 ||
		!row.codec ||
		!row.timebase ||
		(row.frameMode !== "vfr" && row.frameMode !== "cfr")
	) {
		throw new RevisionPublicationError(
			409,
			"Immutable source identity is not ready. Reopen the editor.",
		);
	}
	if (!row.a1Digest || !row.indexId || !row.warmExpiresAt) {
		throw new RevisionPublicationError(
			409,
			"Editor-open warm is missing. Reopen the editor.",
		);
	}
	if (row.warmExpiresAt.getTime() <= now.getTime()) {
		throw new RevisionPublicationError(
			409,
			"Editor-open warm expired. Reopen the editor.",
		);
	}
	if (
		row.liveKey.endsWith("/result.mp4") ||
		row.liveKey.includes("/.recording/outputs/")
	) {
		throw new RevisionPublicationError(
			409,
			"Source identity must be the uncut original, not a rendered result",
		);
	}
	return {
		key: row.liveKey,
		sha256: row.sha256,
		codec: row.codec,
		timebase: row.timebase,
		frameMode: row.frameMode,
	};
}

async function readPreviousSpec(
	tx: PublicationTx,
	input: PublishRevisionInput,
	spec: VideoEditSpecV2,
): Promise<{ previousSpec: VideoEditSpec }> {
	const [publication] = await tx
		.select()
		.from(videoPublication)
		.where(eq(videoPublication.videoId, videoId(input.videoId)));
	const current = publication?.currentRevisionId
		? await readRevision(tx, publication.currentRevisionId)
		: null;
	const currentIntent = current
		? await tx
				.select({ canonicalSpec: editIntent.canonicalSpec })
				.from(editIntent)
				.where(
					and(
						eq(editIntent.videoId, videoId(input.videoId)),
						eq(editIntent.generation, current.generation),
					),
				)
		: [];
	const [rollback] = await tx
		.select({ editSpec: videoEdits.editSpec })
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId(input.videoId)));
	const previousSpec = previousEditionSpec({
		currentSpec:
			(currentIntent[0]?.canonicalSpec as VideoEditSpec | undefined) ?? null,
		rollbackSpec: rollback?.editSpec ?? null,
		sourceDuration: input.sourceDuration ?? spec.sourceDuration,
	});
	if (
		Math.abs(previousSpec.sourceDuration - spec.sourceDuration) > 0.01 &&
		currentIntent[0]
	) {
		throw new RevisionPublicationError(
			409,
			"Video source changed before this edit could publish",
		);
	}
	return { previousSpec };
}

async function readRevision(tx: PublicationTx, revisionId: string) {
	const [row] = await tx
		.select()
		.from(editRevision)
		.where(eq(editRevision.revisionId, revisionId));
	return row ?? null;
}

async function transition(
	database: Database,
	revisionId: string,
	next: string,
	stamp: Date,
) {
	await database.transaction(async (tx) => {
		const revision = await readRevision(tx, revisionId);
		if (!revision) {
			throw new RevisionPublicationError(500, `Unknown revision ${revisionId}`);
		}
		const [publication] = await tx
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, revision.videoId))
			.for("update");
		if (!publication) {
			throw new RevisionPublicationError(500, "Publication row disappeared");
		}
		const legal = LEGAL[revision.state] ?? [];
		if (!legal.includes(next)) {
			throw new RevisionPublicationError(
				500,
				`illegal transition ${revision.state} -> ${next}`,
				publication.generation,
				revisionId,
			);
		}
		if (
			revision.generation !== publication.generation &&
			next !== "SUPERSEDED" &&
			next !== "FAILED"
		) {
			await tx
				.update(editRevision)
				.set({
					state: legal.includes("SUPERSEDED") ? "SUPERSEDED" : "FAILED",
					error: "stale generation",
					updatedAt: stamp,
				})
				.where(eq(editRevision.revisionId, revisionId));
			throw new RevisionPublicationError(
				409,
				`stale generation ${revision.generation} != ${publication.generation}`,
				publication.generation,
				revisionId,
			);
		}
		await tx
			.update(editRevision)
			.set({ state: next, updatedAt: stamp })
			.where(eq(editRevision.revisionId, revisionId));
	});
}

async function produceAndVerify(
	input: PublishRevisionInput,
	spec: VideoEditSpecV2,
	allocated: Allocated,
	origin: OriginClient,
) {
	const durationSeconds = getEditSpecOutputDuration(spec);
	const captions = deriveRevisionCaptions({
		transcript: input.transcript ?? null,
		nextSpec: spec,
	});
	const chapters = deriveRevisionChapters({
		storedChapters: input.chapters ?? [],
		previousSpec: allocated.previousSpec,
		nextSpec: spec,
	});
	const chaptersJson = chaptersDocument({
		chapters,
		durationSeconds,
		sourceId: allocated.sourceId,
	});
	const thumbnailPolicy =
		spec.keepRanges[0]?.start === 0 ? "source-zero" : "seg0-first-frame";
	const prepared = await origin.prepareRevision({
		videoId: input.videoId,
		revisionId: allocated.revisionId,
		intentId: allocated.intentId,
		sourceId: allocated.sourceId,
		generation: allocated.generation,
		durationSeconds,
		keepRanges: spec.keepRanges,
		editSpec: spec,
		captionsVtt: captions.vtt,
		chaptersJson,
		thumbnailPolicy,
	});
	if (
		prepared.seg0DecodedFrames < 1 ||
		prepared.playlistHasEndList !== true ||
		prepared.intentId !== allocated.intentId
	) {
		throw new RevisionPublicationError(
			500,
			"Origin fence rejected the revision before it became current",
			allocated.generation,
			allocated.revisionId,
		);
	}
	const initHead = await origin.fetchArtifact({
		videoId: input.videoId,
		revisionId: allocated.revisionId,
		name: "init.mp4",
		method: "HEAD",
	});
	const segHead = await origin.fetchArtifact({
		videoId: input.videoId,
		revisionId: allocated.revisionId,
		name: "seg/0.m4s",
		method: "HEAD",
	});
	if (initHead.status !== 200 || segHead.status !== 200) {
		throw new RevisionPublicationError(
			500,
			`HEAD init=${initHead.status} seg0=${segHead.status}`,
			allocated.generation,
			allocated.revisionId,
		);
	}
	const init = await origin.fetchArtifact({
		videoId: input.videoId,
		revisionId: allocated.revisionId,
		name: "init.mp4",
		method: "GET",
	});
	const segment = await origin.fetchArtifact({
		videoId: input.videoId,
		revisionId: allocated.revisionId,
		name: "seg/0.m4s",
		method: "GET",
	});
	if (init.status !== 200 || segment.status !== 200) {
		throw new RevisionPublicationError(
			500,
			"GET of init or segment 0 failed",
			allocated.generation,
			allocated.revisionId,
		);
	}
	if (
		!init.body.includes(Buffer.from("ftyp")) ||
		!segment.body.includes(Buffer.from("moof"))
	) {
		throw new RevisionPublicationError(
			500,
			"Fetched init or segment 0 is not a fragmented MP4",
			allocated.generation,
			allocated.revisionId,
		);
	}
	if (
		!digestMatches(init.body, prepared.initSha256) ||
		!digestMatches(segment.body, prepared.seg0Sha256)
	) {
		throw new RevisionPublicationError(
			500,
			"Fetched media does not match the decode attestation",
			allocated.generation,
			allocated.revisionId,
		);
	}
	const firstPlaylist = await readPlaylist(
		origin,
		input.videoId,
		allocated,
		durationSeconds,
	);
	const secondPlaylist = await readPlaylist(
		origin,
		input.videoId,
		allocated,
		durationSeconds,
	);
	if (firstPlaylist !== secondPlaylist) {
		throw new RevisionPublicationError(
			500,
			"Playlist duration is not stable",
			allocated.generation,
			allocated.revisionId,
		);
	}
	await readVerifiedText(
		origin,
		input.videoId,
		allocated,
		"captions.vtt",
		captions.vtt,
	);
	await readVerifiedText(
		origin,
		input.videoId,
		allocated,
		"chapters.json",
		chaptersJson,
	);
	const thumb = await origin.fetchArtifact({
		videoId: input.videoId,
		revisionId: allocated.revisionId,
		name: "thumbnail.jpg",
		method: "GET",
	});
	if (
		thumb.status !== 200 ||
		!thumbnailBindsDuration(thumb.body, durationSeconds)
	) {
		throw new RevisionPublicationError(
			500,
			"Revision thumbnail is missing or not bound to this edition",
			allocated.generation,
			allocated.revisionId,
		);
	}
	return { durationSeconds, captionsVtt: captions.vtt, chaptersJson, chapters };
}

async function readPlaylist(
	origin: OriginClient,
	id: string,
	allocated: Allocated,
	durationSeconds: number,
) {
	const playlist = await origin.fetchArtifact({
		videoId: id,
		revisionId: allocated.revisionId,
		name: "playlist.m3u8",
		method: "GET",
	});
	if (playlist.status !== 200) {
		throw new RevisionPublicationError(
			500,
			`playlist ${playlist.status}`,
			allocated.generation,
			allocated.revisionId,
		);
	}
	const text = playlist.body.toString("utf8");
	if (text.includes("result.mp4") || text.includes("X-Amz-")) {
		throw new RevisionPublicationError(
			500,
			"Playlist exposes a rendered MP4 or a presigned URL",
			allocated.generation,
			allocated.revisionId,
		);
	}
	const duration = playlistDurationSeconds(text);
	if (Math.abs(duration - durationSeconds) > 0.05) {
		throw new RevisionPublicationError(
			500,
			`playlist duration ${duration} != spec ${durationSeconds}`,
			allocated.generation,
			allocated.revisionId,
		);
	}
	return text;
}

async function readVerifiedText(
	origin: OriginClient,
	id: string,
	allocated: Allocated,
	name: string,
	expected: string,
) {
	const artifact = await origin.fetchArtifact({
		videoId: id,
		revisionId: allocated.revisionId,
		name,
		method: "GET",
	});
	if (artifact.status !== 200 || artifact.body.toString("utf8") !== expected) {
		throw new RevisionPublicationError(
			500,
			`${name} resolved ${artifact.status}`,
			allocated.generation,
			allocated.revisionId,
		);
	}
}

async function flipCurrent(
	tx: PublicationTx,
	input: PublishRevisionInput,
	spec: VideoEditSpecV2,
	allocated: Allocated,
	prepared: { durationSeconds: number },
	stamp: Date,
) {
	const [publication] = await tx
		.select()
		.from(videoPublication)
		.where(eq(videoPublication.videoId, videoId(input.videoId)))
		.for("update");
	const revision = await readRevision(tx, allocated.revisionId);
	if (!publication || !revision) {
		throw new RevisionPublicationError(500, "Fence row disappeared");
	}
	if (revision.generation !== publication.generation) {
		await tx
			.update(editRevision)
			.set({ state: "SUPERSEDED", error: "stale generation", updatedAt: stamp })
			.where(eq(editRevision.revisionId, allocated.revisionId));
		throw new RevisionPublicationError(
			409,
			"Stale revision cannot become current",
			publication.generation,
			allocated.revisionId,
		);
	}
	if (
		revision.intentId !== allocated.intentId ||
		revision.sourceId !== allocated.sourceId ||
		revision.state !== "PUBLISHING"
	) {
		throw new RevisionPublicationError(
			500,
			"Fence identity check failed",
			publication.generation,
			allocated.revisionId,
		);
	}
	const [intent] = await tx
		.select()
		.from(editIntent)
		.where(
			and(
				eq(editIntent.videoId, videoId(input.videoId)),
				eq(editIntent.generation, revision.generation),
			),
		);
	if (
		!intent ||
		intent.intentId !== revision.intentId ||
		intent.sourceId !== revision.sourceId
	) {
		throw new RevisionPublicationError(
			500,
			"Intent snapshot does not match the revision",
			publication.generation,
			allocated.revisionId,
		);
	}
	const stamped = await tx
		.select({ id: comments.id, timestamp: comments.timestamp })
		.from(comments)
		.where(eq(comments.videoId, videoId(input.videoId)));
	for (const comment of stamped) {
		const nextTimestamp = remapCommentTimestamp({
			timestamp: comment.timestamp,
			previousSpec: allocated.previousSpec,
			nextSpec: spec,
		});
		if (nextTimestamp === comment.timestamp) continue;
		await tx
			.update(comments)
			.set({ timestamp: nextTimestamp })
			.where(eq(comments.id, comment.id));
	}
	const flipped = await tx
		.update(editRevision)
		.set({ state: "CURRENT", error: null, updatedAt: stamp })
		.where(
			and(
				eq(editRevision.revisionId, allocated.revisionId),
				eq(editRevision.state, "PUBLISHING"),
				eq(editRevision.generation, publication.generation),
			),
		);
	if (affectedRows(flipped) !== 1) {
		throw new RevisionPublicationError(
			409,
			"Current flip compare-and-set failed",
			publication.generation,
			allocated.revisionId,
		);
	}
	const pointed = await tx
		.update(videoPublication)
		.set({
			currentRevisionId: allocated.revisionId,
			publicationEpoch: publication.publicationEpoch + 1,
		})
		.where(
			and(
				eq(videoPublication.videoId, videoId(input.videoId)),
				eq(videoPublication.generation, publication.generation),
			),
		);
	if (affectedRows(pointed) !== 1) {
		throw new RevisionPublicationError(
			409,
			"Publication pointer compare-and-set failed",
			publication.generation,
			allocated.revisionId,
		);
	}
	await bumpPolicyEpoch(input.videoId, tx);
	for (const artifact of [
		"init",
		"seg0",
		"playlist",
		"captions",
		"chapters",
		"thumbnail",
	]) {
		await tx.insert(revisionArtifactStatus).values({
			revisionId: allocated.revisionId,
			artifact,
			state: "READY",
			attempts: 1,
			leaseUntil: null,
			heartbeatAt: stamp,
		});
	}
	await tx.insert(revisionArtifactStatus).values({
		revisionId: allocated.revisionId,
		artifact: "download",
		state: "PENDING",
		attempts: 0,
		leaseUntil: null,
		heartbeatAt: null,
	});
	for (const job of OUTBOX_JOBS) {
		await tx.insert(revisionOutbox).values({
			videoId: videoId(input.videoId),
			revisionId: allocated.revisionId,
			job,
			payload: {
				job,
				revisionId: allocated.revisionId,
				durationSeconds: prepared.durationSeconds,
				downloadReady: false,
			},
			createdAt: stamp,
		});
	}
}

async function failOpenRevision(
	database: Database,
	revisionId: string,
	error: unknown,
	stamp: Date,
) {
	const message = error instanceof Error ? error.message : "publication failed";
	await database
		.update(editRevision)
		.set({ state: "FAILED", error: message.slice(0, 500), updatedAt: stamp })
		.where(
			and(
				eq(editRevision.revisionId, revisionId),
				sql`${editRevision.state} in ('COMMITTED_INTENT','PREPARING','READY','PUBLISHING')`,
			),
		);
}

export async function recordServerDraft(
	database: unknown,
	input: {
		videoId: string;
		draftVersion: number;
		draftSession: string;
	},
): Promise<{ draftVersion: number; draftSession: string; generation: number }> {
	const app = database as Database;
	return app.transaction(async (tx) => {
		await tx
			.select({ id: videos.id })
			.from(videos)
			.where(eq(videos.id, videoId(input.videoId)))
			.for("update");
		await tx
			.insert(videoPublication)
			.values({ videoId: videoId(input.videoId) })
			.onDuplicateKeyUpdate({ set: { videoId: videoId(input.videoId) } });
		const [row] = await tx
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId(input.videoId)))
			.for("update");
		if (!row) {
			throw new RevisionPublicationError(500, "Draft row was not recorded");
		}
		if (
			row.draftSession.length > 0 &&
			row.draftSession !== input.draftSession &&
			input.draftVersion < row.latestDraftVersion
		) {
			throw new RevisionPublicationError(
				409,
				"Draft session does not match the recorded server draft",
				row.generation,
			);
		}
		const nextVersion = Math.max(row.latestDraftVersion, input.draftVersion);
		await tx
			.update(videoPublication)
			.set({
				latestDraftVersion: nextVersion,
				draftSession: input.draftSession,
			})
			.where(eq(videoPublication.videoId, videoId(input.videoId)));
		return {
			draftVersion: nextVersion,
			draftSession: input.draftSession,
			generation: row.generation,
		};
	});
}

export async function claimArtifactLease(
	database: unknown,
	input: {
		revisionId: string;
		artifact: string;
		leaseMs: number;
		now?: Date;
	},
): Promise<{ claimed: boolean; attempts: number }> {
	const app = database as Database;
	const stamp = input.now ?? new Date();
	const until = new Date(stamp.getTime() + input.leaseMs);
	return app.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(revisionArtifactStatus)
			.where(
				and(
					eq(revisionArtifactStatus.revisionId, input.revisionId),
					eq(revisionArtifactStatus.artifact, input.artifact),
				),
			)
			.for("update");
		if (!row) return { claimed: false, attempts: 0 };
		const leased =
			row.state === "LEASED" &&
			row.leaseUntil !== null &&
			row.leaseUntil.getTime() > stamp.getTime();
		if (leased) return { claimed: false, attempts: row.attempts };
		const attempts = row.attempts + 1;
		await tx
			.update(revisionArtifactStatus)
			.set({
				state: "LEASED",
				attempts,
				leaseUntil: until,
				heartbeatAt: stamp,
			})
			.where(
				and(
					eq(revisionArtifactStatus.revisionId, input.revisionId),
					eq(revisionArtifactStatus.artifact, input.artifact),
				),
			);
		return { claimed: true, attempts };
	});
}

export async function markArtifactFailed(
	database: unknown,
	input: { revisionId: string; artifact: string; now?: Date },
) {
	const app = database as Database;
	await app
		.update(revisionArtifactStatus)
		.set({
			state: "ERROR",
			leaseUntil: null,
			heartbeatAt: input.now ?? new Date(),
		})
		.where(
			and(
				eq(revisionArtifactStatus.revisionId, input.revisionId),
				eq(revisionArtifactStatus.artifact, input.artifact),
			),
		);
}

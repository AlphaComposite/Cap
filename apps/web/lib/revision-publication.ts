import { randomBytes } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { db } from "@cap/database";
import {
	comments,
	editIntent,
	editRevision,
	revisionArtifactStatus,
	revisionOutbox,
	sourceObject,
	sourceRelocation,
	videoEdits,
	videoPublication,
	videos,
} from "@cap/database/schema";
import type { VideoEditSpec, VideoEditSpecV2 } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import {
	type EditTranscript,
	getEditTranscriptObjectKey,
	parseEditTranscript,
} from "@/lib/edit-transcript";
import { decryptEditTranscriptObject } from "@/lib/edit-transcript-storage";
import { runtimeObjectStore } from "@/lib/instant-finish-source-relocate";
import {
	PLAYLIST_ORIGIN_SLACK_SECONDS,
	snappedDurationError,
} from "@/lib/revision-duration-check";
import { bumpPolicyEpoch } from "@/lib/revision-media-grant";
import {
	classifyOriginAttestation,
	type OriginAttestation,
	type RangeSnap,
} from "@/lib/revision-media-token";
import { finishMetadataSnapshot } from "@/lib/revision-metadata-snapshot";
import {
	PUBLISH_JOINED_PREPARE,
	trackOriginPrepare,
} from "@/lib/revision-prepare-abort";
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
} from "@/lib/revision-publication-metadata";
import {
	digestMatches,
	type OriginClient,
	type RevisionPrepareResult,
} from "@/lib/revision-publication-origin";
import {
	isVerifiedJpeg,
	thumbnailRetryDelayMs,
	thumbnailSha256,
} from "@/lib/revision-thumbnail";
import {
	assertFinishInventoryClear,
	assertFinishSourceKey,
} from "@/lib/source-relocation";

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
	READY: ["PUBLISHING", "SUPERSEDED", "EXPIRED"],
	PUBLISHING: ["CURRENT", "FAILED"],
	CURRENT: [],
	SUPERSEDED: [],
	EXPIRED: [],
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

function attestationRejectMessage(reason: "mac" | "version" | "shape"): string {
	if (reason === "version") return "unsupported attestation version";
	return "Origin attestation MAC was missing or forged";
}

type PreparedMedia = {
	durationSeconds: number;
	captionsVtt: string;
	chaptersJson: string;
	chapters: { title: string; start: number }[];
	attestedDurationSeconds: number;
	keepRanges: { start: number; end: number }[];
	sourceDuration?: number;
	timescale: number;
	maxHoldTicks: number;
	durationTicks: number;
	rangeSnaps: RangeSnap[];
	initSha256: string;
	seg0Sha256: string;
	attestationMac: string;
	attestationBody: string;
};

async function storeReadyAttestation(
	database: Database,
	revisionId: string,
	prepared: PreparedMedia,
	stamp: Date,
) {
	await database
		.update(editRevision)
		.set({
			metadataSnapshot: {
				captionsVtt: prepared.captionsVtt,
				chapters: prepared.chapters,
				summaryStatus: "persisted",
				summaryDerived: false,
				summaryText: null,
				thumbnail: "unavailable",
				durationSeconds: prepared.durationSeconds,
				attestationMac: prepared.attestationMac,
				attestationBody: prepared.attestationBody,
			},
			updatedAt: stamp,
		})
		.where(eq(editRevision.revisionId, revisionId));
}

export async function expireAbandonedPreparedRevisions(
	database: unknown,
	now: Date,
	maxAgeMs = 15 * 60 * 1000,
) {
	const cutoff = new Date(now.getTime() - maxAgeMs);
	await (database as Database)
		.update(editRevision)
		.set({ state: "EXPIRED", error: "expired", updatedAt: now })
		.where(
			and(eq(editRevision.state, "READY"), lt(editRevision.updatedAt, cutoff)),
		);
}

async function sameSessionPreclick(
	publication: {
		generation: number;
		draftSession: string;
		currentGeneration: number | null;
	},
	input: PublishRevisionInput,
) {
	return (
		input.baseGeneration === publication.generation ||
		(input.baseGeneration + 1 === publication.generation &&
			publication.draftSession === input.draftSession &&
			publication.currentGeneration !== publication.generation)
	);
}

async function reuseVerifiedReady(
	app: Database,
	input: PublishRevisionInput,
	spec: VideoEditSpecV2,
	_deps: PublishRevisionDeps,
	now: () => Date,
): Promise<PublishRevisionSuccess | null> {
	const stamp = now();
	const found = await app.transaction(async (tx) => {
		await tx
			.select({ id: videos.id })
			.from(videos)
			.where(eq(videos.id, videoId(input.videoId)))
			.for("update");
		const [publication] = await tx
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId(input.videoId)))
			.for("update");
		if (!publication || !(await sameSessionPreclick(publication, input))) {
			return null;
		}
		const identity = await readReadySource(tx, input.videoId, stamp);
		const sourceId = sourceIdFromIdentity(identity);
		const intentId = intentIdFor({
			sourceId,
			spec,
			mappingVersion: MAPPING_VERSION,
			profile: ENCODER_PROFILE,
		});
		const [row] = await tx
			.select()
			.from(editRevision)
			.where(
				and(
					eq(editRevision.videoId, videoId(input.videoId)),
					eq(editRevision.intentId, intentId),
					eq(editRevision.state, "READY"),
					eq(editRevision.generation, publication.generation),
				),
			);
		if (
			!row?.metadataSnapshot?.attestationMac ||
			!row.metadataSnapshot.attestationBody
		) {
			return null;
		}
		const classified = classifyOriginAttestation(
			row.metadataSnapshot.attestationMac,
			row.metadataSnapshot.attestationBody,
		);
		if (!classified.ok || classified.attestation.intentId !== intentId) {
			throw new RevisionPublicationError(
				500,
				classified.ok
					? "Stored prepare attestation MAC was missing or forged"
					: attestationRejectMessage(classified.reason),
				publication.generation,
				row.revisionId,
			);
		}
		const attested = classified.attestation;
		const snapError = snappedDurationError({
			keepRanges: spec.keepRanges,
			timescale: attested.timescale,
			maxHoldTicks: attested.maxHoldTicks,
			durationTicks: attested.durationTicks,
			rangeSnaps: attested.rangeSnaps,
			sourceDuration: spec.sourceDuration,
		});
		if (snapError) {
			throw new RevisionPublicationError(
				500,
				snapError,
				publication.generation,
				row.revisionId,
			);
		}
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
		if (row.error === PUBLISH_JOINED_PREPARE) {
			await tx
				.update(editRevision)
				.set({ error: null, updatedAt: stamp })
				.where(eq(editRevision.revisionId, row.revisionId));
		}
		return {
			allocated: {
				idempotent: false,
				revisionId: row.revisionId,
				generation: row.generation,
				intentId,
				sourceId,
				previousSpec: previous.previousSpec,
			},
			attested,
			captionsVtt: row.metadataSnapshot.captionsVtt,
		};
	});
	if (!found) return null;
	const mediaDuration = found.attested.playlistDurationSeconds;
	const captionsVtt = found.captionsVtt ?? "";
	const chapters = deriveRevisionChapters({
		storedChapters: input.chapters ?? [],
		previousSpec: found.allocated.previousSpec,
		nextSpec: spec,
	});
	await transition(app, found.allocated.revisionId, "PUBLISHING", now());
	await app.transaction(async (tx) => {
		await flipCurrent(
			tx,
			input,
			spec,
			found.allocated,
			{
				durationSeconds: mediaDuration,
				captionsVtt,
				chaptersJson: chaptersDocument({
					chapters,
					// Origin wrote this at prepare, before the snap was known. Readback compares bytes.
					durationSeconds: getEditSpecOutputDuration(spec),
					sourceId: found.allocated.sourceId,
				}),
				chapters,
				attestedDurationSeconds: mediaDuration,
				keepRanges: spec.keepRanges,
				sourceDuration: spec.sourceDuration,
				timescale: found.attested.timescale,
				maxHoldTicks: found.attested.maxHoldTicks,
				durationTicks: found.attested.durationTicks,
				rangeSnaps: found.attested.rangeSnaps,
				initSha256: found.attested.initSha256,
				seg0Sha256: found.attested.seg0Sha256,
				attestationMac: "",
				attestationBody: "",
			},
			now(),
		);
	});
	return {
		success: true,
		revisionId: found.allocated.revisionId,
		generation: found.allocated.generation,
	};
}

async function allocateInputAfterPreclick(
	app: Database,
	input: PublishRevisionInput,
): Promise<PublishRevisionInput> {
	const [publication] = await app
		.select()
		.from(videoPublication)
		.where(eq(videoPublication.videoId, videoId(input.videoId)));
	if (!publication || input.baseGeneration === publication.generation)
		return input;
	if (!(await sameSessionPreclick(publication, input))) return input;
	const ready = await app
		.select({ revisionId: editRevision.revisionId })
		.from(editRevision)
		.where(
			and(
				eq(editRevision.videoId, videoId(input.videoId)),
				eq(editRevision.generation, publication.generation),
				eq(editRevision.state, "READY"),
			),
		);
	// An in-flight prepare is not READY. Keep the caller's baseGeneration so
	// allocateRevision can join it instead of allocating a second revision.
	if (ready.length === 0) return input;
	return { ...input, baseGeneration: publication.generation };
}

export async function prepareInstantFinishRevision(
	database: unknown,
	input: PublishRevisionInput,
	deps: PublishRevisionDeps,
): Promise<PublishRevisionSuccess> {
	const app = database as Database;
	const spec = requireV2Spec(input.editSpec);
	assertServableEncoderProfile(ENCODER_PROFILE);
	const now = deps.now ?? (() => new Date());
	await expireAbandonedPreparedRevisions(app, now());
	const mintRevisionId = deps.randomRevisionId ?? newRevisionId;
	const allocated = await app.transaction(async (tx) =>
		allocateRevision(
			tx,
			await allocateInputAfterPreclick(app, input),
			spec,
			now(),
			mintRevisionId,
		),
	);
	if (allocated.idempotent || allocated.join) {
		return {
			success: true,
			revisionId: allocated.revisionId,
			generation: allocated.generation,
		};
	}
	const stopTracking = trackOriginPrepare(allocated.revisionId);
	try {
		await transition(app, allocated.revisionId, "PREPARING", now());
		const prepared = await produceAndVerify(
			app,
			input,
			spec,
			allocated,
			deps.origin,
		);
		await storeReadyAttestation(app, allocated.revisionId, prepared, now());
		const ready = await transition(
			app,
			allocated.revisionId,
			"READY",
			now(),
			"PREPARING",
		);
		if (!ready) {
			return {
				success: true,
				revisionId: allocated.revisionId,
				generation: allocated.generation,
			};
		}
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
			error instanceof Error ? error.message : "Revision prepare failed",
			allocated.generation,
			allocated.revisionId,
		);
	} finally {
		stopTracking();
	}
}

const JOIN_POLL_MS = 25;
const JOIN_POLL_LIMIT = 800;

async function waitForJoinedRevision(
	app: Database,
	revisionId: string,
): Promise<"ready" | "current" | "failed"> {
	for (let attempt = 0; attempt < JOIN_POLL_LIMIT; attempt++) {
		const [row] = await app
			.select({ state: editRevision.state })
			.from(editRevision)
			.where(eq(editRevision.revisionId, revisionId));
		if (!row) return "failed";
		if (row.state === "READY") return "ready";
		if (row.state === "CURRENT") return "current";
		if (
			row.state === "FAILED" ||
			row.state === "SUPERSEDED" ||
			row.state === "EXPIRED"
		) {
			return "failed";
		}
		await new Promise((resolve) => setTimeout(resolve, JOIN_POLL_MS));
	}
	return "failed";
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
	const reused = await reuseVerifiedReady(app, input, spec, deps, now);
	if (reused) return reused;
	const mintRevisionId = deps.randomRevisionId ?? newRevisionId;
	const publishInput = await allocateInputAfterPreclick(app, input);
	let allocated = await app.transaction(async (tx) =>
		allocateRevision(tx, publishInput, spec, now(), mintRevisionId),
	);
	for (let joined = 0; allocated.join && joined < 2; joined++) {
		const ready = await waitForJoinedRevision(app, allocated.revisionId);
		if (ready === "current") {
			return {
				success: true,
				revisionId: allocated.revisionId,
				generation: allocated.generation,
			};
		}
		if (ready === "ready") {
			const flipped = await reuseVerifiedReady(app, input, spec, deps, now);
			if (flipped) return flipped;
		}
		allocated = await app.transaction(async (tx) =>
			allocateRevision(tx, publishInput, spec, now(), mintRevisionId),
		);
	}
	if (allocated.join) {
		throw new RevisionPublicationError(
			409,
			"in-flight prepare did not finish",
			allocated.generation,
			allocated.revisionId,
		);
	}
	if (allocated.idempotent) {
		return {
			success: true,
			revisionId: allocated.revisionId,
			generation: allocated.generation,
		};
	}
	const stopTracking = trackOriginPrepare(allocated.revisionId);
	try {
		if (deps.onAllocated) await deps.onAllocated(allocated);
		await transition(app, allocated.revisionId, "PREPARING", now());
		const prepared = await produceAndVerify(
			app,
			input,
			spec,
			allocated,
			deps.origin,
		);
		await storeReadyAttestation(app, allocated.revisionId, prepared, now());
		const ready = await transition(
			app,
			allocated.revisionId,
			"READY",
			now(),
			"PREPARING",
		);
		if (!ready) {
			throw new RevisionPublicationError(
				499,
				"Prepare aborted",
				allocated.generation,
				allocated.revisionId,
			);
		}
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
	} finally {
		stopTracking();
	}
}

type Allocated = {
	idempotent: boolean;
	join?: boolean;
	revisionId: string;
	generation: number;
	intentId: string;
	sourceId: string;
	previousSpec: VideoEditSpec;
};

export async function allocateRevision(
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
	const identity = await readReadySource(tx, input.videoId, stamp);
	const sourceId = sourceIdFromIdentity(identity);
	const intentId = intentIdFor({
		sourceId,
		spec,
		mappingVersion: MAPPING_VERSION,
		profile: ENCODER_PROFILE,
	});
	const previous = await readPreviousSpec(tx, input, spec);
	if (input.baseGeneration !== publication.generation) {
		if (!(await sameSessionPreclick(publication, input))) {
			throw new RevisionPublicationError(
				409,
				`generation ${input.baseGeneration} != ${publication.generation}`,
				publication.generation,
			);
		}
		const [inflight] = await tx
			.select()
			.from(editRevision)
			.where(
				and(
					eq(editRevision.videoId, videoId(input.videoId)),
					eq(editRevision.generation, publication.generation),
					sql`${editRevision.state} in ('COMMITTED_INTENT','PREPARING')`,
				),
			);
		if (inflight?.intentId === intentId) {
			const marked = await tx
				.update(editRevision)
				.set({ error: PUBLISH_JOINED_PREPARE, updatedAt: stamp })
				.where(
					and(
						eq(editRevision.revisionId, inflight.revisionId),
						sql`${editRevision.state} in ('COMMITTED_INTENT','PREPARING')`,
					),
				);
			if (affectedRows(marked) === 1) {
				return {
					idempotent: false,
					join: true,
					revisionId: inflight.revisionId,
					generation: inflight.generation,
					intentId,
					sourceId,
					previousSpec: previous.previousSpec,
				};
			}
		}
	}
	const current = publication.currentRevisionId
		? await readRevision(tx, publication.currentRevisionId)
		: null;
	const currentMatches =
		current &&
		current.state === "CURRENT" &&
		current.intentId === intentId &&
		publication.currentGeneration != null &&
		current.generation === publication.currentGeneration;
	const sameSessionRetry =
		publication.draftSession === input.draftSession &&
		input.draftVersion >= publication.latestDraftVersion;
	if (
		input.expectedEditSpec &&
		!areEditSpecDocumentsEquivalent(
			previous.previousSpec,
			input.expectedEditSpec,
		) &&
		!(currentMatches && sameSessionRetry)
	) {
		throw new RevisionPublicationError(
			409,
			"This video was edited in another session. Reload before publishing.",
			publication.generation,
		);
	}
	if (currentMatches && current) {
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
	const [sameIntent] = await tx
		.select()
		.from(editRevision)
		.where(
			and(
				eq(editRevision.videoId, videoId(input.videoId)),
				eq(editRevision.intentId, intentId),
				sql`${editRevision.state} in ('COMMITTED_INTENT','PREPARING')`,
			),
		);
	if (sameIntent) {
		const marked = await tx
			.update(editRevision)
			.set({ error: PUBLISH_JOINED_PREPARE, updatedAt: stamp })
			.where(
				and(
					eq(editRevision.revisionId, sameIntent.revisionId),
					sql`${editRevision.state} in ('COMMITTED_INTENT','PREPARING')`,
				),
			);
		if (affectedRows(marked) === 1) {
			return {
				idempotent: false,
				join: true,
				revisionId: sameIntent.revisionId,
				generation: sameIntent.generation,
				intentId,
				sourceId,
				previousSpec: previous.previousSpec,
			};
		}
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
		.set({ state: "EXPIRED", error: "expired", updatedAt: stamp })
		.where(
			and(
				eq(editRevision.videoId, videoId(input.videoId)),
				lt(editRevision.generation, nextGeneration),
				eq(editRevision.state, "READY"),
			),
		);
	await tx
		.update(editRevision)
		.set({ state: "SUPERSEDED", error: "superseded", updatedAt: stamp })
		.where(
			and(
				eq(editRevision.videoId, videoId(input.videoId)),
				lt(editRevision.generation, nextGeneration),
				sql`${editRevision.state} in ('COMMITTED_INTENT','PREPARING')`,
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
	const relocations = await tx
		.select({
			newKey: sourceRelocation.newKey,
			state: sourceRelocation.state,
		})
		.from(sourceRelocation)
		.where(eq(sourceRelocation.videoId, videoId(id)));
	try {
		assertFinishSourceKey({
			liveKey: row.liveKey,
			relocations,
		});
	} catch (error) {
		throw new RevisionPublicationError(
			409,
			error instanceof Error
				? error.message
				: "Finish SourceId must use the relocated liveKey",
		);
	}
	if (relocations.some((row) => row.state !== "PURGED")) {
		throw new RevisionPublicationError(
			409,
			"Finish refused until source relocation is PURGED and liveKey is the relocated key",
		);
	}
	const [owner] = await tx
		.select({ ownerId: videos.ownerId })
		.from(videos)
		.where(eq(videos.id, videoId(id)));
	const prefix = `${owner?.ownerId ?? ""}/${id}/`;
	const listed = finishInventoryProbe.listPrefix
		? await finishInventoryProbe.listPrefix(prefix)
		: await runtimeObjectStore().list?.(prefix);
	assertFinishInventoryClear(listed, prefix);
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

async function lockVideoRow(tx: PublicationTx, id: Video.VideoId) {
	await tx
		.select({ id: videos.id })
		.from(videos)
		.where(eq(videos.id, id))
		.for("update");
}

export const revisionLockProbe: {
	afterPublicationLock?: () => Promise<void>;
} = {};

export const finishInventoryProbe: {
	listPrefix?: (prefix: string) => Promise<string[]>;
	getObject?: (key: string) => Promise<string | null>;
} = {};

export async function transition(
	database: Database,
	revisionId: string,
	next: string,
	stamp: Date,
	expected?: string,
): Promise<boolean> {
	return database.transaction(async (tx) => {
		const revision = await readRevision(tx, revisionId);
		if (!revision) {
			throw new RevisionPublicationError(500, `Unknown revision ${revisionId}`);
		}
		// videos before video_publication, same order as allocateRevision.
		// The edit_revision update takes an FK shared lock on videos; taking
		// publication first deadlocks with allocateRevision.
		await lockVideoRow(tx, revision.videoId);
		const [publication] = await tx
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, revision.videoId))
			.for("update");
		if (!publication) {
			throw new RevisionPublicationError(500, "Publication row disappeared");
		}
		if (revisionLockProbe.afterPublicationLock) {
			await revisionLockProbe.afterPublicationLock();
		}
		if (expected && revision.state !== expected) return false;
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
		const updated = await tx
			.update(editRevision)
			.set({ state: next, updatedAt: stamp })
			.where(
				expected
					? and(
							eq(editRevision.revisionId, revisionId),
							eq(editRevision.state, expected),
						)
					: eq(editRevision.revisionId, revisionId),
			);
		if (expected && affectedRows(updated) !== 1) return false;
		return true;
	});
}

const TRANSCRIPT_DURATION_TOLERANCE_MS = 250;

async function readTranscriptObject(key: string): Promise<string | null> {
	if (finishInventoryProbe.getObject) {
		try {
			return await finishInventoryProbe.getObject(key);
		} catch {
			return null;
		}
	}
	try {
		const env = serverEnv();
		if (!env.CAP_AWS_BUCKET) return null;
		const client = new S3Client({
			region: env.CAP_AWS_REGION,
			endpoint: env.S3_INTERNAL_ENDPOINT,
			forcePathStyle: env.S3_PATH_STYLE,
			credentials: {
				accessKeyId: env.CAP_AWS_ACCESS_KEY ?? "",
				secretAccessKey: env.CAP_AWS_SECRET_KEY ?? "",
			},
		});
		const response = await client.send(
			new GetObjectCommand({ Bucket: env.CAP_AWS_BUCKET, Key: key }),
		);
		return (await response.Body?.transformToString()) ?? null;
	} catch {
		return null;
	}
}

async function loadStoredEditTranscript(
	app: Database,
	id: string,
	spec: VideoEditSpecV2,
): Promise<EditTranscript | null> {
	const [video] = await app
		.select({ ownerId: videos.ownerId })
		.from(videos)
		.where(eq(videos.id, videoId(id)));
	if (!video?.ownerId) return null;
	const key = getEditTranscriptObjectKey(video.ownerId, id);
	let raw = await readTranscriptObject(key);
	if (!raw) {
		const rows = await app
			.select({
				newKey: sourceRelocation.newKey,
				state: sourceRelocation.state,
			})
			.from(sourceRelocation)
			.where(
				and(
					eq(sourceRelocation.videoId, videoId(id)),
					eq(sourceRelocation.oldKey, key),
				),
			);
		const moved = (["PURGED", "DELETED", "POINTER", "COPIED"] as const)
			.map((state) => rows.find((row) => row.state === state))
			.find((row) => row?.newKey && row.newKey !== key);
		if (moved?.newKey) raw = await readTranscriptObject(moved.newKey);
	}
	if (!raw) return null;
	const decrypted = decryptEditTranscriptObject(raw, video.ownerId, id);
	const transcript = decrypted ? parseEditTranscript(decrypted) : null;
	if (!transcript) return null;
	const expected = Math.round(spec.sourceDuration * 1000);
	if (
		Math.abs(transcript.durationMs - expected) >
		TRANSCRIPT_DURATION_TOLERANCE_MS
	) {
		return null;
	}
	return transcript;
}

async function produceAndVerify(
	app: Database,
	input: PublishRevisionInput,
	spec: VideoEditSpecV2,
	allocated: Allocated,
	origin: OriginClient,
) {
	const durationSeconds = getEditSpecOutputDuration(spec);
	const captions = deriveRevisionCaptions({
		transcript: await loadStoredEditTranscript(app, input.videoId, spec),
		nextSpec: spec,
	});
	const chapters = deriveRevisionChapters({
		storedChapters: input.chapters ?? [],
		previousSpec: allocated.previousSpec,
		nextSpec: spec,
	});
	const thumbnailPolicy =
		spec.keepRanges[0]?.start === 0 ? "source-zero" : "seg0-first-frame";
	const chaptersJson = chaptersDocument({
		chapters,
		durationSeconds,
		sourceId: allocated.sourceId,
	});
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
	const attested = assertSignedPrepareAttestation(
		prepared,
		allocated,
		spec.keepRanges,
		spec.sourceDuration,
	);
	const mediaDuration = attested.playlistDurationSeconds;
	return {
		durationSeconds: mediaDuration,
		captionsVtt: captions.vtt,
		chaptersJson,
		chapters,
		attestedDurationSeconds: mediaDuration,
		keepRanges: spec.keepRanges,
		sourceDuration: spec.sourceDuration,
		timescale: attested.timescale,
		maxHoldTicks: attested.maxHoldTicks,
		durationTicks: attested.durationTicks,
		rangeSnaps: attested.rangeSnaps,
		initSha256: attested.initSha256,
		seg0Sha256: attested.seg0Sha256,
		attestationMac: prepared.attestationMac,
		attestationBody: prepared.attestationBody,
	};
}

async function readPlaylist(
	origin: OriginClient,
	id: string,
	allocated: Allocated,
	check: {
		attestedDurationSeconds: number;
		keepRanges: { start: number; end: number }[];
		sourceDuration?: number;
		timescale: number;
		maxHoldTicks: number;
		durationTicks: number;
		rangeSnaps: RangeSnap[];
	},
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
	if (
		Math.abs(duration - check.attestedDurationSeconds) >
		PLAYLIST_ORIGIN_SLACK_SECONDS
	) {
		throw new RevisionPublicationError(
			500,
			`playlist duration ${duration} != origin ${check.attestedDurationSeconds}`,
			allocated.generation,
			allocated.revisionId,
		);
	}
	const snapError = snappedDurationError({
		keepRanges: check.keepRanges,
		timescale: check.timescale,
		maxHoldTicks: check.maxHoldTicks,
		durationTicks: check.durationTicks,
		rangeSnaps: check.rangeSnaps,
		sourceDuration: check.sourceDuration,
	});
	if (snapError) {
		throw new RevisionPublicationError(
			500,
			snapError,
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

export async function flipCurrent(
	tx: PublicationTx,
	input: PublishRevisionInput,
	spec: VideoEditSpecV2,
	allocated: Allocated,
	prepared: PreparedMedia,
	stamp: Date,
) {
	await lockVideoRow(tx, videoId(input.videoId));
	const [publication] = await tx
		.select()
		.from(videoPublication)
		.where(eq(videoPublication.videoId, videoId(input.videoId)))
		.for("update");
	if (revisionLockProbe.afterPublicationLock) {
		await revisionLockProbe.afterPublicationLock();
	}
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
	const [videoRow] = await tx
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId(input.videoId)));
	const snapshot = finishMetadataSnapshot({
		captionsVtt: prepared.captionsVtt,
		chapters: prepared.chapters,
		summaryText: videoRow?.metadata?.summary ?? null,
		thumbnail:
			spec.keepRanges[0]?.start === 0 ? "source-zero" : "seg0-first-frame",
		durationSeconds: prepared.durationSeconds,
	});
	const previousRevisionId = publication.currentRevisionId;
	const previousGeneration = publication.currentGeneration;
	const flipped = await tx
		.update(editRevision)
		.set({
			state: "CURRENT",
			error: null,
			updatedAt: stamp,
			metadataSnapshot: snapshot,
		})
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
			currentGeneration: allocated.generation,
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
			state: artifact === "thumbnail" ? "PENDING" : "READY",
			attempts: artifact === "thumbnail" ? 0 : 1,
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
			payload:
				job === "readback"
					? {
							job,
							revisionId: allocated.revisionId,
							videoId: input.videoId,
							previousRevisionId,
							previousGeneration,
							durationSeconds: prepared.durationSeconds,
							attestedDurationSeconds: prepared.attestedDurationSeconds,
							keepRanges: prepared.keepRanges,
							sourceDuration: prepared.sourceDuration,
							timescale: prepared.timescale,
							maxHoldTicks: prepared.maxHoldTicks,
							durationTicks: prepared.durationTicks,
							rangeSnaps: prepared.rangeSnaps,
							initSha256: prepared.initSha256,
							seg0Sha256: prepared.seg0Sha256,
							captionsVtt: prepared.captionsVtt,
							chaptersJson: prepared.chaptersJson,
						}
					: {
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

type ReadbackPayload = {
	videoId: string;
	revisionId: string;
	previousRevisionId: string | null;
	previousGeneration: number | null;
	durationSeconds: number;
	attestedDurationSeconds: number;
	keepRanges: { start: number; end: number }[];
	sourceDuration?: number;
	timescale: number;
	maxHoldTicks: number;
	durationTicks: number;
	rangeSnaps: RangeSnap[];
	initSha256: string;
	seg0Sha256: string;
	captionsVtt: string;
	chaptersJson: string;
};

export type ReadbackResult = {
	ok: boolean;
	reverted: boolean;
	skipped: boolean;
	reason?: string;
};

const READBACK_POLL_MS = 1_500;
const READBACK_LEASE_MS = 15_000;
const READBACK_MAX_ATTEMPTS = 5;

let readbackInFlight: Promise<void> | null = null;
let readbackWorker: ReturnType<typeof setInterval> | null = null;

export function alertRevisionReadbackFailure(detail: {
	videoId: string;
	revisionId: string;
	reason: string;
}) {
	console.error(
		"cap-revision-readback-failed",
		detail.videoId,
		detail.revisionId,
		detail.reason,
	);
}

export function pendingRevisionReadbacks(): Promise<void> {
	return readbackInFlight ?? Promise.resolve();
}

export function readbackDue(
	payload: Record<string, unknown>,
	now: Date,
): boolean {
	const notBefore =
		typeof payload.notBefore === "string" ? Date.parse(payload.notBefore) : 0;
	const leaseUntil =
		typeof payload.leaseUntil === "string" ? Date.parse(payload.leaseUntil) : 0;
	return (
		(!Number.isFinite(notBefore) || notBefore <= now.getTime()) &&
		(!Number.isFinite(leaseUntil) || leaseUntil <= now.getTime())
	);
}

export function startRevisionReadbackWorker(input: {
	database: unknown;
	origin: OriginClient;
	pollMs?: number;
	now?: () => Date;
	onTick?: () => Promise<void>;
}): { stop: () => void } {
	if (readbackWorker) return { stop: stopRevisionReadbackWorker };
	const pollMs = Math.min(input.pollMs ?? READBACK_POLL_MS, 2_000);
	const tick = () => {
		if (readbackInFlight) return;
		const run = sweepRevisionReadbacks(input.database, {
			origin: input.origin,
			now: input.now?.(),
		}).then(async () => {
			await input.onTick?.();
		});
		readbackInFlight = run;
		const clear = () => {
			if (readbackInFlight === run) readbackInFlight = null;
		};
		void run.then(clear, clear);
	};
	tick();
	readbackWorker = setInterval(tick, pollMs);
	return { stop: stopRevisionReadbackWorker };
}

export function stopRevisionReadbackWorker() {
	if (readbackWorker) clearInterval(readbackWorker);
	readbackWorker = null;
}

function assertSignedPrepareAttestation(
	prepared: RevisionPrepareResult,
	allocated: Allocated,
	keepRanges: { start: number; end: number }[],
	sourceDuration?: number,
): OriginAttestation {
	const classified = classifyOriginAttestation(
		prepared.attestationMac,
		prepared.attestationBody,
	);
	if (
		!classified.ok ||
		classified.attestation.intentId !== allocated.intentId
	) {
		throw new RevisionPublicationError(
			500,
			classified.ok
				? "Origin attestation MAC was missing or forged"
				: attestationRejectMessage(classified.reason),
			allocated.generation,
			allocated.revisionId,
		);
	}
	const attested = classified.attestation;
	if (
		Math.abs(attested.playlistDurationSeconds - attested.durationSeconds) >
		PLAYLIST_ORIGIN_SLACK_SECONDS
	) {
		throw new RevisionPublicationError(
			500,
			`attested duration ${attested.playlistDurationSeconds} != origin ${attested.durationSeconds}`,
			allocated.generation,
			allocated.revisionId,
		);
	}
	const snapError = snappedDurationError({
		keepRanges,
		timescale: attested.timescale,
		maxHoldTicks: attested.maxHoldTicks,
		durationTicks: attested.durationTicks,
		rangeSnaps: attested.rangeSnaps,
		sourceDuration,
	});
	if (snapError) {
		throw new RevisionPublicationError(
			500,
			snapError,
			allocated.generation,
			allocated.revisionId,
		);
	}
	return attested;
}

function isReadbackPayload(value: unknown): value is ReadbackPayload {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.videoId === "string" &&
		typeof record.revisionId === "string" &&
		typeof record.durationSeconds === "number" &&
		typeof record.attestedDurationSeconds === "number" &&
		Array.isArray(record.keepRanges) &&
		Number.isSafeInteger(record.timescale) &&
		Number.isSafeInteger(record.maxHoldTicks) &&
		Number.isSafeInteger(record.durationTicks) &&
		Array.isArray(record.rangeSnaps) &&
		typeof record.initSha256 === "string" &&
		typeof record.seg0Sha256 === "string" &&
		typeof record.captionsVtt === "string" &&
		typeof record.chaptersJson === "string"
	);
}

async function verifyRevisionArtifacts(
	origin: OriginClient,
	payload: ReadbackPayload,
) {
	const allocated = {
		revisionId: payload.revisionId,
		generation: 0,
		idempotent: false,
		intentId: "",
		sourceId: "",
		previousSpec: { version: 1, sourceDuration: 0, keepRanges: [] },
	} as Allocated;
	const initHead = await origin.fetchArtifact({
		videoId: payload.videoId,
		revisionId: payload.revisionId,
		name: "init.mp4",
		method: "HEAD",
	});
	const segHead = await origin.fetchArtifact({
		videoId: payload.videoId,
		revisionId: payload.revisionId,
		name: "seg/0.m4s",
		method: "HEAD",
	});
	if (initHead.status !== 200 || segHead.status !== 200) {
		throw new RevisionPublicationError(
			500,
			`HEAD init=${initHead.status} seg0=${segHead.status}`,
		);
	}
	const init = await origin.fetchArtifact({
		videoId: payload.videoId,
		revisionId: payload.revisionId,
		name: "init.mp4",
		method: "GET",
	});
	const segment = await origin.fetchArtifact({
		videoId: payload.videoId,
		revisionId: payload.revisionId,
		name: "seg/0.m4s",
		method: "GET",
	});
	if (init.status !== 200 || segment.status !== 200) {
		throw new RevisionPublicationError(500, "GET of init or segment 0 failed");
	}
	if (
		!init.body.includes(Buffer.from("ftyp")) ||
		!segment.body.includes(Buffer.from("moof"))
	) {
		throw new RevisionPublicationError(
			500,
			"Fetched init or segment 0 is not a fragmented MP4",
		);
	}
	if (
		!digestMatches(init.body, payload.initSha256) ||
		!digestMatches(segment.body, payload.seg0Sha256)
	) {
		throw new RevisionPublicationError(
			500,
			"Fetched media does not match the decode attestation",
		);
	}
	const playlistCheck = {
		attestedDurationSeconds: payload.attestedDurationSeconds,
		keepRanges: payload.keepRanges,
		sourceDuration:
			typeof payload.sourceDuration === "number"
				? payload.sourceDuration
				: undefined,
		timescale: payload.timescale,
		maxHoldTicks: payload.maxHoldTicks,
		durationTicks: payload.durationTicks,
		rangeSnaps: payload.rangeSnaps,
	};
	const firstPlaylist = await readPlaylist(
		origin,
		payload.videoId,
		allocated,
		playlistCheck,
	);
	const secondPlaylist = await readPlaylist(
		origin,
		payload.videoId,
		allocated,
		playlistCheck,
	);
	if (firstPlaylist !== secondPlaylist) {
		throw new RevisionPublicationError(500, "Playlist duration is not stable");
	}
	await readVerifiedText(
		origin,
		payload.videoId,
		allocated,
		"captions.vtt",
		payload.captionsVtt,
	);
	await readVerifiedText(
		origin,
		payload.videoId,
		allocated,
		"chapters.json",
		payload.chaptersJson,
	);
}

async function revertCurrentAfterReadback(
	database: Database,
	payload: ReadbackPayload,
	reason: string,
	stamp: Date,
): Promise<boolean> {
	return database.transaction(async (tx) => {
		await lockVideoRow(tx, videoId(payload.videoId));
		const [publication] = await tx
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId(payload.videoId)))
			.for("update");
		if (!publication || publication.currentRevisionId !== payload.revisionId) {
			return false;
		}
		await tx
			.update(editRevision)
			.set({ state: "FAILED", error: reason.slice(0, 500), updatedAt: stamp })
			.where(
				and(
					eq(editRevision.revisionId, payload.revisionId),
					eq(editRevision.state, "CURRENT"),
				),
			);
		await tx
			.update(revisionArtifactStatus)
			.set({ state: "ERROR", leaseUntil: null, heartbeatAt: stamp })
			.where(eq(revisionArtifactStatus.revisionId, payload.revisionId));
		const pointed = await tx
			.update(videoPublication)
			.set({
				currentRevisionId: payload.previousRevisionId,
				currentGeneration: payload.previousGeneration,
				publicationEpoch: publication.publicationEpoch + 1,
			})
			.where(
				and(
					eq(videoPublication.videoId, videoId(payload.videoId)),
					eq(videoPublication.currentRevisionId, payload.revisionId),
				),
			);
		if (affectedRows(pointed) !== 1) return false;
		await bumpPolicyEpoch(payload.videoId, tx);
		return true;
	});
}

export async function runRevisionReadback(
	database: unknown,
	input: {
		revisionId: string;
		origin: OriginClient;
		now?: Date;
		alert?: (detail: {
			videoId: string;
			revisionId: string;
			reason: string;
		}) => void;
	},
): Promise<ReadbackResult> {
	const swept = await sweepRevisionReadbacks(database, {
		origin: input.origin,
		now: input.now,
		revisionId: input.revisionId,
		alert: input.alert,
		limit: 1,
	});
	return swept[0] ?? { ok: true, reverted: false, skipped: true };
}

type ClaimedReadback = {
	id: number;
	payload: ReadbackPayload;
	attempts: number;
	leaseToken: string;
};

export async function claimRevisionReadback(
	database: unknown,
	input: { now?: Date; revisionId?: string; workerId?: string } = {},
): Promise<ClaimedReadback | null> {
	return claimDueReadback(database as Database, input.now ?? new Date(), {
		revisionId: input.revisionId,
		workerId: input.workerId ?? "readback",
	});
}

export async function completeRevisionReadback(
	database: unknown,
	claimed: ClaimedReadback,
	origin: OriginClient,
	stamp = new Date(),
	alert = alertRevisionReadbackFailure,
): Promise<ReadbackResult> {
	return finishClaimedReadback(
		database as Database,
		claimed,
		origin,
		stamp,
		alert,
	);
}

export async function sweepRevisionReadbacks(
	database: unknown,
	input: {
		origin: OriginClient;
		now?: Date;
		limit?: number;
		revisionId?: string;
		workerId?: string;
		alert?: (detail: {
			videoId: string;
			revisionId: string;
			reason: string;
		}) => void;
	},
): Promise<ReadbackResult[]> {
	const app = database as Database;
	const stamp = input.now ?? new Date();
	const results: ReadbackResult[] = [];
	const limit = input.limit ?? 8;
	for (let index = 0; index < limit; index += 1) {
		const claimed = await claimDueReadback(app, stamp, {
			revisionId: input.revisionId,
			workerId: input.workerId ?? "readback",
		});
		if (!claimed) break;
		results.push(
			await finishClaimedReadback(
				app,
				claimed,
				input.origin,
				stamp,
				input.alert,
			),
		);
	}
	return results;
}

async function claimDueReadback(
	database: Database,
	stamp: Date,
	input: { revisionId?: string; workerId: string },
): Promise<ClaimedReadback | null> {
	const claimed = await database.transaction(async (tx) => {
		const nowMs = stamp.getTime();
		const rows = await tx
			.select()
			.from(revisionOutbox)
			.where(
				and(
					eq(revisionOutbox.job, "readback"),
					input.revisionId
						? eq(revisionOutbox.revisionId, input.revisionId)
						: undefined,
					sql`(
						JSON_EXTRACT(${revisionOutbox.payload}, '$.leaseUntilMs') IS NULL
						OR CAST(JSON_UNQUOTE(JSON_EXTRACT(${revisionOutbox.payload}, '$.leaseUntilMs')) AS UNSIGNED) <= ${nowMs}
					)`,
					sql`(
						JSON_EXTRACT(${revisionOutbox.payload}, '$.notBeforeMs') IS NULL
						OR CAST(JSON_UNQUOTE(JSON_EXTRACT(${revisionOutbox.payload}, '$.notBeforeMs')) AS UNSIGNED) <= ${nowMs}
					)`,
				),
			)
			.orderBy(asc(revisionOutbox.id))
			.limit(1)
			.for("update", { skipLocked: true });
		const due = rows[0];
		if (
			!due ||
			!isReadbackPayload(due.payload) ||
			!readbackDue(due.payload, stamp)
		) {
			return null;
		}
		const raw = due.payload as ReadbackPayload & { attempts?: number };
		const attempts = typeof raw.attempts === "number" ? raw.attempts + 1 : 1;
		if (attempts > READBACK_MAX_ATTEMPTS) {
			alertRevisionReadbackFailure({
				videoId: raw.videoId,
				revisionId: raw.revisionId,
				reason: "readback attempts exhausted",
			});
			const leaseToken = randomBytes(16).toString("hex");
			const leaseUntilMs = stamp.getTime() + READBACK_LEASE_MS;
			await tx
				.update(revisionOutbox)
				.set({
					payload: {
						...due.payload,
						attempts,
						workerId: input.workerId,
						leaseToken,
						leaseUntilMs,
						leaseUntil: new Date(leaseUntilMs).toISOString(),
					},
				})
				.where(eq(revisionOutbox.id, due.id));
			return {
				id: due.id,
				payload: raw,
				attempts,
				leaseToken,
				exhausted: true as const,
			};
		}
		const leaseToken = randomBytes(16).toString("hex");
		const leaseUntilMs = stamp.getTime() + READBACK_LEASE_MS;
		await tx
			.update(revisionOutbox)
			.set({
				payload: {
					...due.payload,
					attempts,
					workerId: input.workerId,
					leaseToken,
					leaseUntilMs,
					leaseUntil: new Date(leaseUntilMs).toISOString(),
				},
			})
			.where(eq(revisionOutbox.id, due.id));
		return { id: due.id, payload: due.payload, attempts, leaseToken };
	});
	if (!claimed || !("exhausted" in claimed)) return claimed;
	if (!(await readbackLeaseHeld(database, claimed.id, claimed.leaseToken))) {
		return null;
	}
	await revertCurrentAfterReadback(
		database,
		claimed.payload,
		"readback attempts exhausted",
		stamp,
	);
	if (await readbackLeaseHeld(database, claimed.id, claimed.leaseToken)) {
		await database
			.delete(revisionOutbox)
			.where(
				and(
					eq(revisionOutbox.id, claimed.id),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${revisionOutbox.payload}, '$.leaseToken')) = ${claimed.leaseToken}`,
				),
			);
	}
	return null;
}

async function readbackLeaseHeld(
	database: Database,
	id: number,
	leaseToken: string,
) {
	const [row] = await database
		.select({ payload: revisionOutbox.payload })
		.from(revisionOutbox)
		.where(eq(revisionOutbox.id, id));
	const payload = row?.payload as { leaseToken?: string } | undefined;
	return payload?.leaseToken === leaseToken;
}

async function finishClaimedReadback(
	database: Database,
	claimed: ClaimedReadback,
	origin: OriginClient,
	stamp: Date,
	alert = alertRevisionReadbackFailure,
): Promise<ReadbackResult> {
	if (!(await readbackLeaseHeld(database, claimed.id, claimed.leaseToken))) {
		return { ok: true, reverted: false, skipped: true, reason: "lease-lost" };
	}
	const current = await publicationPointsAt(database, claimed.payload);
	if (!current) {
		if (await readbackLeaseHeld(database, claimed.id, claimed.leaseToken)) {
			await database
				.delete(revisionOutbox)
				.where(
					and(
						eq(revisionOutbox.id, claimed.id),
						sql`JSON_UNQUOTE(JSON_EXTRACT(${revisionOutbox.payload}, '$.leaseToken')) = ${claimed.leaseToken}`,
					),
				);
		}
		return { ok: true, reverted: false, skipped: true, reason: "stale" };
	}
	try {
		await verifyRevisionArtifacts(origin, claimed.payload);
		await recordThumbnailStatus(database, origin, claimed.payload, stamp);
		if (!(await readbackLeaseHeld(database, claimed.id, claimed.leaseToken))) {
			return { ok: true, reverted: false, skipped: true, reason: "lease-lost" };
		}
		await database
			.delete(revisionOutbox)
			.where(
				and(
					eq(revisionOutbox.id, claimed.id),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${revisionOutbox.payload}, '$.leaseToken')) = ${claimed.leaseToken}`,
				),
			);
		return { ok: true, reverted: false, skipped: false };
	} catch (error) {
		const reason = error instanceof Error ? error.message : "readback failed";
		const bounded =
			claimed.attempts >= READBACK_MAX_ATTEMPTS
				? `readback attempts exhausted: ${reason}`
				: reason;
		alert({
			videoId: claimed.payload.videoId,
			revisionId: claimed.payload.revisionId,
			reason: bounded,
		});
		if (!(await readbackLeaseHeld(database, claimed.id, claimed.leaseToken))) {
			return { ok: true, reverted: false, skipped: true, reason: "lease-lost" };
		}
		const stillCurrent = await publicationPointsAt(database, claimed.payload);
		if (!stillCurrent) {
			await database
				.delete(revisionOutbox)
				.where(
					and(
						eq(revisionOutbox.id, claimed.id),
						sql`JSON_UNQUOTE(JSON_EXTRACT(${revisionOutbox.payload}, '$.leaseToken')) = ${claimed.leaseToken}`,
					),
				);
			return { ok: true, reverted: false, skipped: true, reason: "stale" };
		}
		const reverted = await revertCurrentAfterReadback(
			database,
			claimed.payload,
			bounded,
			stamp,
		);
		await database
			.delete(revisionOutbox)
			.where(
				and(
					eq(revisionOutbox.id, claimed.id),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${revisionOutbox.payload}, '$.leaseToken')) = ${claimed.leaseToken}`,
				),
			);
		return { ok: false, reverted, skipped: false, reason: bounded };
	}
}

async function publicationPointsAt(
	database: Database,
	payload: ReadbackPayload,
): Promise<boolean> {
	const [publication] = await database
		.select({ currentRevisionId: videoPublication.currentRevisionId })
		.from(videoPublication)
		.where(eq(videoPublication.videoId, videoId(payload.videoId)));
	return publication?.currentRevisionId === payload.revisionId;
}

async function recordThumbnailStatus(
	database: Database,
	origin: OriginClient,
	payload: ReadbackPayload,
	stamp: Date,
) {
	const [status] = await database
		.select()
		.from(revisionArtifactStatus)
		.where(
			and(
				eq(revisionArtifactStatus.revisionId, payload.revisionId),
				eq(revisionArtifactStatus.artifact, "thumbnail"),
			),
		);
	if (
		status?.leaseUntil &&
		status.leaseUntil.getTime() > stamp.getTime() &&
		status.state !== "READY"
	) {
		return;
	}
	const thumb = await origin.fetchArtifact({
		videoId: payload.videoId,
		revisionId: payload.revisionId,
		name: "thumbnail.jpg",
		method: "GET",
	});
	const verified = thumb.status === 200 && isVerifiedJpeg(thumb.body);
	const attempts = (status?.attempts ?? 0) + (verified ? 0 : 1);
	const state = verified ? "READY" : attempts >= 3 ? "FAILED" : "PENDING";
	await database
		.update(revisionArtifactStatus)
		.set({
			state,
			attempts,
			leaseUntil: verified
				? null
				: new Date(stamp.getTime() + thumbnailRetryDelayMs(attempts)),
			heartbeatAt: stamp,
		})
		.where(
			and(
				eq(revisionArtifactStatus.revisionId, payload.revisionId),
				eq(revisionArtifactStatus.artifact, "thumbnail"),
			),
		);
	if (!verified || !status) return;
	const digest = thumbnailSha256(thumb.body);
	const [revision] = await database
		.select({ metadataSnapshot: editRevision.metadataSnapshot })
		.from(editRevision)
		.where(eq(editRevision.revisionId, payload.revisionId));
	if (!revision?.metadataSnapshot) return;
	await database
		.update(editRevision)
		.set({
			metadataSnapshot: {
				...revision.metadataSnapshot,
				thumbnailSha256: digest,
			},
		})
		.where(eq(editRevision.revisionId, payload.revisionId));
}

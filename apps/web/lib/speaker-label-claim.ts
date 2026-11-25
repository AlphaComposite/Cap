import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { db } from "@cap/database";
import { serverEnv } from "@cap/env";
import type { AiGenerationLanguage } from "@cap/web-domain";
import { sql } from "drizzle-orm";
import { FatalError, RetryableError } from "workflow";
import { z } from "zod";

export const SPEAKER_LABEL_JOB = "speaker-label-submit";
const LEGACY_TRANSCRIPT_JOB = "legacy-transcript-submit";
export const SPEAKER_LABEL_DEADLINE_MS = 20 * 60 * 1000;

const bindingSchema = z.object({
	videoId: z.string().min(1),
	ownerId: z.string().min(1),
	bucket: z.string().nullable(),
	storageIntegrationId: z.string().nullable(),
	sourceKey: z.string().min(1),
	sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const submitSchema = bindingSchema.extend({
	token: z.string().uuid(),
	language: z.string().min(1),
	deadlineMs: z.number().finite().positive(),
});
const claimSchema = z.discriminatedUnion("state", [
	submitSchema.extend({
		state: z.literal("submitting"),
		transcriptId: z.undefined(),
	}),
	submitSchema.extend({
		state: z.literal("accepted"),
		transcriptId: z.string().min(1),
	}),
]);
const reservationSchema = bindingSchema
	.omit({ sourceKey: true, sourceSha256: true })
	.extend({
		state: z.literal("reserved"),
		token: z.string().uuid(),
		language: z.string().min(1),
		transcriptId: z.undefined(),
	});
const durableSchema = z.union([claimSchema, reservationSchema]);
export type SpeakerLabelSource = z.infer<typeof bindingSchema>;
export type SpeakerLabelClaim = z.infer<typeof claimSchema>;
type SpeakerLabelReservation = z.infer<typeof reservationSchema>;
type Executor = Pick<ReturnType<typeof db>, "execute">;

function rows(result: unknown): Record<string, unknown>[] {
	if (!Array.isArray(result) || !Array.isArray(result[0])) {
		throw new FatalError("Speaker-label durable state unavailable");
	}
	return result[0];
}

async function lockRecording(videoId: string, executor: Executor) {
	const found = rows(
		await executor.execute(sql`
		SELECT id, transcriptionStatus, ownerId, bucket, storageIntegrationId
		FROM videos WHERE id = ${videoId} FOR UPDATE
	`),
	);
	if (
		found.length !== 1 ||
		found[0]?.id !== videoId ||
		(found[0].transcriptionStatus !== null &&
			typeof found[0].transcriptionStatus !== "string")
	) {
		throw new FatalError("Speaker-label recording requires reconciliation");
	}
	return found[0];
}

export async function hasLegacyTranscriptAdmission(
	videoId: string,
	executor: Executor = db(),
) {
	return (
		rows(
			await executor.execute(sql`
		SELECT payload FROM outbox
		WHERE videoId = ${videoId} AND job = ${LEGACY_TRANSCRIPT_JOB}
		FOR UPDATE
	`),
		).length > 0
	);
}

function requireOneWrite(result: unknown) {
	if (!Array.isArray(result) || result[0]?.affectedRows !== 1) {
		throw new FatalError("Speaker-label durable write requires reconciliation");
	}
}

function speakerLabelSelection() {
	const {
		CAP_TRANSCRIPT_SPEAKER_LABELS_CANARY: startup,
		CAP_TRANSCRIPT_SPEAKER_LABELS_CANARY_FILE: file,
	} = serverEnv();
	if (!file) return startup;
	if (startup) throw new FatalError("Conflicting speaker-label selectors");
	let selection: string;
	try {
		selection = readFileSync(file, "utf8");
	} catch (error) {
		// An empty selector directory is the normal state before the operator binds.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new FatalError("Cannot read speaker-label selector");
	}
	if (!/^[0-9a-z]{15}\/[0-9a-z]{15}\/[0-9]{13}$/.test(selection)) {
		throw new FatalError("Invalid speaker-label selector");
	}
	return selection;
}

export function isSpeakerLabelCanary(video: {
	id: string;
	ownerId: string;
	createdAt: Date;
}): boolean {
	const selection = speakerLabelSelection();
	if (!selection) return false;
	const [ownerId, videoId, since] = selection.split("/");
	return (
		ownerId === video.ownerId &&
		videoId === video.id &&
		Number(since) >= Date.now() - 60 * 60 * 1000 &&
		video.createdAt.getTime() >= Number(since) &&
		video.createdAt.getTime() <= Date.now()
	);
}

export async function loadSpeakerLabelClaim(
	videoId: string,
	executor: Executor = db(),
): Promise<SpeakerLabelClaim | SpeakerLabelReservation | null> {
	const found = rows(
		await executor.execute(sql`
		SELECT payload FROM outbox
		WHERE videoId = ${videoId} AND job = ${SPEAKER_LABEL_JOB}
		FOR UPDATE
	`),
	);
	if (!found.length) return null;
	const parsed = durableSchema.safeParse(found[0]?.payload);
	if (
		found.length !== 1 ||
		!parsed.success ||
		parsed.data.videoId !== videoId
	) {
		throw new FatalError("Speaker-label claim requires reconciliation");
	}
	return parsed.data;
}

export async function loadSpeakerLabelSource(
	videoId: string,
	ownerId: string,
	executor: Executor = db(),
): Promise<SpeakerLabelSource> {
	const found = rows(
		await executor.execute(sql`
		SELECT v.id AS videoId, v.ownerId, v.bucket, v.storageIntegrationId, v.transcriptionStatus,
			s.liveKey AS sourceKey, s.sha256 AS sourceSha256,
			JSON_UNQUOTE(JSON_EXTRACT(v.source, '$.type')) AS sourceType,
			u.phase AS uploadPhase,
			JSON_EXTRACT(v.metadata, '$.liveTranscript') AS liveTranscript,
			EXISTS(SELECT 1 FROM video_edits e WHERE e.videoId = v.id) AS edited
		FROM videos v
		LEFT JOIN source_object s ON s.videoId = v.id
		LEFT JOIN video_uploads u ON u.video_id = v.id
		WHERE v.id = ${videoId} AND v.ownerId = ${ownerId}
	`),
	);
	if (found.length !== 1) {
		throw new FatalError("Speaker-label source requires reconciliation");
	}
	const source = found[0];
	if (source?.transcriptionStatus === "COMPLETE") {
		throw new FatalError("Speaker-label transcription already completed");
	}
	const parsed = bindingSchema.safeParse(source);
	if (
		source?.sourceType !== "webMP4" ||
		source.liveTranscript != null ||
		Number(source.edited) !== 0
	) {
		throw new FatalError("Speaker-label completed original source unavailable");
	}
	if (
		!parsed.success ||
		!parsed.data.sourceKey.startsWith(`private/source/${videoId}/`) ||
		(source.uploadPhase != null && source.uploadPhase !== "complete")
	) {
		throw new RetryableError("Speaker-label preserved source is not ready", {
			retryAfter: "5 seconds",
		});
	}
	return parsed.data;
}

function sameSource(left: SpeakerLabelSource, right: SpeakerLabelSource) {
	return Object.keys(bindingSchema.shape).every(
		(key) =>
			left[key as keyof SpeakerLabelSource] ===
			right[key as keyof SpeakerLabelSource],
	);
}

export async function reserveSpeakerLabelRecording(
	video: {
		id: string;
		ownerId: string;
		bucket?: string | null;
		storageIntegrationId?: string | null;
	},
	language: AiGenerationLanguage,
	completedOnly = false,
) {
	return db().transaction(async (tx) => {
		// Outbox has no unique job key; every claimant locks the same parent first.
		const current = await lockRecording(video.id, tx);
		const existing = await loadSpeakerLabelClaim(video.id, tx);
		if (await hasLegacyTranscriptAdmission(video.id, tx)) {
			throw new FatalError(
				"Legacy transcription holds this recording; no label admission",
			);
		}
		if (
			existing?.state === "accepted" &&
			(existing.ownerId !== current.ownerId ||
				existing.bucket !== current.bucket ||
				existing.storageIntegrationId !== current.storageIntegrationId ||
				existing.ownerId !== video.ownerId ||
				existing.bucket !== (video.bucket ?? null) ||
				existing.storageIntegrationId !== (video.storageIntegrationId ?? null))
		) {
			throw new FatalError("Speaker-label recording storage changed");
		}
		if (current.transcriptionStatus === "COMPLETE") {
			if (existing?.state !== "accepted") {
				throw new FatalError(
					"Speaker-label canary cannot backfill an existing transcript",
				);
			}
			return { claim: existing, completed: true };
		}
		if (completedOnly) {
			throw new FatalError(
				"Speaker-label claim holds this recording; reconciliation required",
			);
		}
		if (existing && existing.state !== "accepted") {
			throw new FatalError(
				"Speaker-labeled submission outcome unknown; do not resubmit",
			);
		}
		if (current.transcriptionStatus !== "PROCESSING") {
			requireOneWrite(
				await tx.execute(sql`
				UPDATE videos SET transcriptionStatus = 'PROCESSING'
				WHERE id = ${video.id}
				AND (transcriptionStatus IS NULL OR transcriptionStatus <> 'COMPLETE')
			`),
			);
		}
		if (existing) return { claim: existing, completed: false };
		const reservation: SpeakerLabelReservation = {
			state: "reserved",
			videoId: video.id,
			ownerId: video.ownerId,
			bucket: video.bucket ?? null,
			storageIntegrationId: video.storageIntegrationId ?? null,
			language,
			token: randomUUID(),
		};
		requireOneWrite(
			await tx.execute(sql`
			INSERT INTO outbox (videoId, revisionId, job, payload, createdAt)
			VALUES (${video.id}, 'speaker-label-v1', ${SPEAKER_LABEL_JOB},
				${JSON.stringify(reservation)}, NOW(3))
		`),
		);
		return { claim: reservation, completed: false };
	});
}

export async function reserveSpeakerLabelSubmit(
	source: SpeakerLabelSource,
	language: AiGenerationLanguage,
	reservationToken?: string,
): Promise<{ submit: boolean; claim: SpeakerLabelClaim }> {
	return db().transaction(async (tx) => {
		const video = await lockRecording(source.videoId, tx);
		if (video.transcriptionStatus === "COMPLETE") {
			throw new FatalError("Speaker-label transcription already completed");
		}
		const current = await loadSpeakerLabelSource(
			source.videoId,
			source.ownerId,
			tx,
		);
		if (!sameSource(source, current)) {
			throw new FatalError(
				"Speaker-label source changed; reconciliation required",
			);
		}
		const existing = await loadSpeakerLabelClaim(source.videoId, tx);
		if (!existing || existing.language !== language) {
			throw new FatalError("Speaker-label reservation required");
		}
		if (existing.state !== "reserved") {
			if (!sameSource(source, existing))
				throw new FatalError("Speaker-label claim source mismatch");
			if (!existing.transcriptId)
				throw new FatalError(
					"Speaker-labeled submission outcome unknown; do not resubmit",
				);
			return { submit: false, claim: existing };
		}
		if (
			existing.token !== reservationToken ||
			existing.ownerId !== source.ownerId ||
			existing.bucket !== source.bucket ||
			existing.storageIntegrationId !== source.storageIntegrationId
		) {
			throw new FatalError(
				"Speaker-label reservation changed; reconciliation required",
			);
		}
		const claim: SpeakerLabelClaim = {
			...source,
			state: "submitting",
			language,
			token: existing.token,
			deadlineMs: Date.now() + SPEAKER_LABEL_DEADLINE_MS,
		};
		requireOneWrite(
			await tx.execute(sql`
			UPDATE outbox SET payload = ${JSON.stringify(claim)}
			WHERE videoId = ${source.videoId} AND job = ${SPEAKER_LABEL_JOB}
		`),
		);
		return { submit: true, claim };
	});
}

export async function persistSpeakerLabelId(
	claim: SpeakerLabelClaim,
	transcriptId: string,
): Promise<void> {
	if (!transcriptId) throw new FatalError("Speaker-label accepted ID required");
	await db().transaction(async (tx) => {
		await lockRecording(claim.videoId, tx);
		const current = await loadSpeakerLabelClaim(claim.videoId, tx);
		if (
			!current ||
			current.state !== "submitting" ||
			current.token !== claim.token ||
			current.transcriptId
		) {
			throw new FatalError(
				"Speaker-label claim changed; reconciliation required",
			);
		}
		requireOneWrite(
			await tx.execute(sql`
			UPDATE outbox SET payload = ${JSON.stringify({ ...current, state: "accepted", transcriptId })}
			WHERE videoId = ${claim.videoId} AND job = ${SPEAKER_LABEL_JOB}
		`),
		);
	});
	const saved = await loadSpeakerLabelClaim(claim.videoId);
	if (saved?.token !== claim.token || saved.transcriptId !== transcriptId) {
		throw new FatalError("Speaker-label accepted ID requires reconciliation");
	}
}

export async function assertSpeakerLabelSource(claim: SpeakerLabelClaim) {
	const current = await loadSpeakerLabelSource(claim.videoId, claim.ownerId);
	if (!sameSource(claim, current)) {
		throw new FatalError(
			"Speaker-label source changed; reconciliation required",
		);
	}
}

export async function assertNoSpeakerLabelClaim(videoId: string) {
	await db().transaction(async (tx) => {
		await lockRecording(videoId, tx);
		if (await loadSpeakerLabelClaim(videoId, tx)) {
			throw new FatalError(
				"Speaker-label claim holds this recording; no fallback submission",
			);
		}
		// This fence only excludes labels; legacy step retries keep their existing semantics.
		if (await hasLegacyTranscriptAdmission(videoId, tx)) return;
		if (speakerLabelSelection()?.split("/")[1] === videoId) {
			throw new FatalError(
				"Speaker-label claim holds this recording; no fallback submission",
			);
		}
		requireOneWrite(
			await tx.execute(sql`
			INSERT INTO outbox (videoId, revisionId, job, payload, createdAt)
			VALUES (${videoId}, 'legacy-transcript-v1', ${LEGACY_TRANSCRIPT_JOB},
				${JSON.stringify({ videoId })}, NOW(3))
		`),
		);
	});
}

const providerResult = z.object({
	id: z.string().min(1),
	status: z.enum(["queued", "processing", "completed", "error"]),
	error: z.string().nullish(),
	audio_duration: z.number().finite().nonnegative().nullish(),
	words: z.array(z.record(z.unknown())).nullish(),
	language_code: z.unknown(),
	speech_model_used: z.unknown(),
});

export async function pollSpeakerLabelTranscript(claim: SpeakerLabelClaim) {
	if (claim.state !== "accepted" || !claim.transcriptId) {
		throw new FatalError(
			"Speaker-label unknown outcome requires reconciliation",
		);
	}
	while (Date.now() < claim.deadlineMs) {
		const response = await fetch(
			`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(claim.transcriptId)}`,
			{
				headers: { Authorization: serverEnv().ASSEMBLY_API_KEY as string },
				signal: AbortSignal.timeout(
					Math.max(1, Math.min(15_000, claim.deadlineMs - Date.now())),
				),
			},
		);
		let waitMs = 3000;
		if (response.ok) {
			const parsed = providerResult.safeParse(await response.json());
			if (!parsed.success || parsed.data.id !== claim.transcriptId) {
				throw new FatalError(
					"Speaker-labeled transcript ID or response mismatch",
				);
			}
			if (Date.now() >= claim.deadlineMs) break;
			if (
				parsed.data.status === "completed" ||
				parsed.data.status === "error"
			) {
				return parsed.data;
			}
		} else if (response.status === 429 || response.status >= 500) {
			const retryAfter = response.headers.get("Retry-After");
			const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
			const delay = Number.isFinite(seconds)
				? seconds * 1000
				: Date.parse(retryAfter ?? "") - Date.now();
			waitMs = Number.isFinite(delay) ? Math.max(waitMs, delay) : 30_000;
			await response.body?.cancel();
		} else {
			throw new FatalError(
				"Speaker-label polling rejected; reconcile known ID",
			);
		}
		await new Promise((resolve) =>
			setTimeout(
				resolve,
				Math.max(0, Math.min(waitMs, claim.deadlineMs - Date.now())),
			),
		);
	}
	throw new FatalError(
		"Speaker-label polling deadline exhausted; reconcile known ID",
	);
}

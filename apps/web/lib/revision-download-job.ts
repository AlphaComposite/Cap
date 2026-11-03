import type { db } from "@cap/database";
import {
	editRevision,
	revisionArtifactStatus,
	revisionOutbox,
	videoPublication,
	videos,
} from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, asc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
	DOWNLOAD_TRANSFER_MS,
	type DownloadReceipt,
	hlsSnapshot,
	persistRevisionDownload,
	persistRevisionHls,
	verifiedDownloadReceipt,
	verifiedHlsReceipt,
} from "@/lib/revision-download-artifact";
import { readArtifactReady } from "@/lib/revision-media-grant";
import type { OriginClient } from "@/lib/revision-publication-origin";

type Database = ReturnType<typeof db>;

export const DOWNLOAD_MAX_FAILURES = 8;
export const DOWNLOAD_MAX_POLLS = 240;
export const DOWNLOAD_MAX_FAILED_CYCLES = 3;
export const DOWNLOAD_FAILED_COOLDOWN_MS = 30 * 60 * 1000;
const DOWNLOAD_LEASE_MS = DOWNLOAD_TRANSFER_MS + 120_000;
const DOWNLOAD_POLL_MS = 5_000;
const DOWNLOAD_BACKOFF_MS = [
	2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];

export type DownloadPlan =
	| { action: "ready" }
	| { action: "skip" }
	| {
			action: "retry";
			notBeforeMs: number;
			failures: number;
			polls: number;
	  }
	| { action: "yield" }
	| { action: "exhausted"; failures: number };

type DownloadPayload = {
	job: "download";
	revisionId: string;
	videoId: string;
	attempts?: number;
	polls?: number;
	/** A non-busy failure happened this round, so it spends a failed cycle;
	 * a round of only encode-busy failures waits out the cooldown instead. */
	hardFailure?: boolean;
	notBeforeMs?: number;
	leaseUntilMs?: number;
	leaseToken?: string;
};

export function planDownloadAttempt(input: {
	current: boolean;
	originStatus: number;
	failures: number;
	polls: number;
	nowMs: number;
}): DownloadPlan {
	if (!input.current || input.originStatus === 409) return { action: "skip" };
	if (input.originStatus === 200) return { action: "ready" };
	if (input.originStatus === 202) {
		const polls = input.polls + 1;
		if (polls > DOWNLOAD_MAX_POLLS) return { action: "yield" };
		return {
			action: "retry",
			notBeforeMs: input.nowMs + DOWNLOAD_POLL_MS,
			failures: input.failures,
			polls,
		};
	}
	const failures = input.failures + 1;
	if (failures > DOWNLOAD_MAX_FAILURES) {
		return { action: "exhausted", failures };
	}
	const delay =
		DOWNLOAD_BACKOFF_MS[
			Math.min(failures - 1, DOWNLOAD_BACKOFF_MS.length - 1)
		] ?? DOWNLOAD_POLL_MS;
	return {
		action: "retry",
		notBeforeMs: input.nowMs + delay,
		failures,
		polls: input.polls,
	};
}

export function downloadFailureClass(error: unknown): string {
	const name = error instanceof Error ? error.name : "Error";
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "Error";
}

export function alertRevisionDownloadFailure(detail: {
	videoId: string;
	revisionId: string;
	reason: string;
}) {
	console.error(
		"cap-revision-download-failed",
		detail.videoId,
		detail.revisionId,
		detail.reason,
	);
}

function isDownloadPayload(value: unknown): value is DownloadPayload {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.job === "download" &&
		typeof record.revisionId === "string" &&
		typeof record.videoId === "string"
	);
}

function asVideoId(value: string): Video.VideoId {
	return value as Video.VideoId;
}

async function publicationPointsAt(
	database: Database,
	payload: DownloadPayload,
): Promise<boolean> {
	const [publication] = await database
		.select({ currentRevisionId: videoPublication.currentRevisionId })
		.from(videoPublication)
		.where(eq(videoPublication.videoId, asVideoId(payload.videoId)));
	return publication?.currentRevisionId === payload.revisionId;
}

async function deleteLeased(
	database: Database,
	id: number,
	leaseToken: string,
) {
	await database
		.delete(revisionOutbox)
		.where(
			and(
				eq(revisionOutbox.id, id),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${revisionOutbox.payload}, '$.leaseToken')) = ${leaseToken}`,
			),
		);
}

async function leaseHeld(database: Database, id: number, leaseToken: string) {
	const [row] = await database
		.select({ payload: revisionOutbox.payload })
		.from(revisionOutbox)
		.where(eq(revisionOutbox.id, id));
	const payload = row?.payload as DownloadPayload | undefined;
	return payload?.leaseToken === leaseToken;
}

export async function markRevisionDownloadReady(
	database: Database,
	claimed: { id: number; payload: DownloadPayload; leaseToken: string },
	receipt: DownloadReceipt,
	keepJob = false,
) {
	if (
		!verifiedDownloadReceipt(receipt, receipt) ||
		(receipt.hls !== undefined &&
			!verifiedHlsReceipt(receipt, receipt, receipt.hls.snapshot)) ||
		receipt.revisionId !== claimed.payload.revisionId ||
		receipt.videoId !== claimed.payload.videoId
	)
		throw new Error("DownloadReceiptInvalid");
	return database.transaction(async (tx) => {
		// NOW is fixed at statement start; acquire every completion lock before checking lease expiry.
		const locked = await tx.execute(sql`
			SELECT r.revisionId FROM video_publication p
			JOIN edit_revision r ON BINARY r.videoId = BINARY p.videoId
			JOIN videos v ON BINARY v.id = BINARY r.videoId
			JOIN outbox o ON o.id = ${claimed.id}
			JOIN revision_artifact_status a ON BINARY a.revisionId = BINARY r.revisionId AND a.artifact = 'download'
			WHERE BINARY r.revisionId = BINARY ${receipt.revisionId} AND BINARY p.videoId = BINARY ${receipt.videoId}
			FOR UPDATE
		`);
		const rows =
			Array.isArray(locked) && Array.isArray(locked[0]) ? locked[0] : [];
		if (rows.length === 0) return false;
		const result = await tx.execute(sql`
			UPDATE edit_revision r
			JOIN video_publication p ON BINARY p.videoId = BINARY r.videoId
			JOIN videos v ON BINARY v.id = BINARY r.videoId
			JOIN outbox o ON o.id = ${claimed.id}
			JOIN revision_artifact_status a ON BINARY a.revisionId = BINARY r.revisionId AND a.artifact = 'download'
			SET r.metadataSnapshot = JSON_SET(COALESCE(r.metadataSnapshot, JSON_OBJECT()),
				'$.downloadArtifact', CAST(${JSON.stringify(receipt)} AS JSON), '$.downloadReady', CAST('true' AS JSON), '$.hlsDurabilityStarted', CAST('true' AS JSON)),
				r.updatedAt = CURRENT_TIMESTAMP(3), a.state = 'READY', a.leaseUntil = NULL, a.heartbeatAt = CURRENT_TIMESTAMP(3)
			WHERE BINARY r.revisionId = BINARY ${receipt.revisionId}
				AND BINARY r.videoId = BINARY ${receipt.videoId}
				AND BINARY v.ownerId = BINARY ${receipt.ownerId}
				AND BINARY r.sourceId = BINARY ${receipt.sourceId} AND r.generation = ${receipt.generation}
				AND r.state = 'CURRENT' AND BINARY p.currentRevisionId = BINARY r.revisionId AND p.currentGeneration = r.generation
				AND BINARY o.revisionId = BINARY r.revisionId AND BINARY o.videoId = BINARY r.videoId AND o.job = 'download'
				AND BINARY JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.leaseToken')) = BINARY ${claimed.leaseToken}
				AND CAST(JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.leaseUntilMs')) AS UNSIGNED) > UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000
				AND ${
					receipt.hls
						? sql`
					BINARY COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.metadataSnapshot, '$.captionsVtt')), '') = BINARY ${receipt.hls.snapshot.captionsVtt}
					AND COALESCE(JSON_EXTRACT(r.metadataSnapshot, '$.chapters'), JSON_ARRAY()) = CAST(${JSON.stringify(receipt.hls.snapshot.chapters)} AS JSON)
					AND BINARY COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.metadataSnapshot, '$.thumbnailSha256')), '') = BINARY ${receipt.hls.snapshot.thumbnailSha256}
				`
						: sql`TRUE`
				}
		`);
		const header = (Array.isArray(result) ? result[0] : result) as {
			affectedRows?: number;
		};
		const completed = (header?.affectedRows ?? 0) > 0;
		if (completed && !keepJob)
			await deleteLeased(
				tx as unknown as Database,
				claimed.id,
				claimed.leaseToken,
			);
		return completed;
	});
}

async function reschedule(
	database: Database,
	id: number,
	leaseToken: string,
	payload: DownloadPayload,
	plan: Extract<DownloadPlan, { action: "retry" }>,
) {
	if (!(await leaseHeld(database, id, leaseToken))) return;
	await database
		.update(revisionOutbox)
		.set({
			payload: {
				...payload,
				attempts: plan.failures,
				polls: plan.polls,
				notBeforeMs: plan.notBeforeMs,
				leaseToken: null,
				leaseUntilMs: null,
			},
		})
		.where(
			and(
				eq(revisionOutbox.id, id),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${revisionOutbox.payload}, '$.leaseToken')) = ${leaseToken}`,
				sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${revisionOutbox.payload}, '$.leaseUntilMs')) AS UNSIGNED) > UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000`,
			),
		);
}

async function claimDueDownload(
	database: Database,
	stamp: Date,
): Promise<{
	id: number;
	payload: DownloadPayload;
	leaseToken: string;
} | null> {
	return database.transaction(async (tx) => {
		const nowMs = stamp.getTime();
		const rows = await tx
			.select()
			.from(revisionOutbox)
			.where(
				and(
					eq(revisionOutbox.job, "download"),
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
		if (!due || !isDownloadPayload(due.payload)) return null;
		const leaseToken = crypto.randomUUID().replace(/-/g, "");
		const leaseUntilMs = nowMs + DOWNLOAD_LEASE_MS;
		await tx
			.update(revisionOutbox)
			.set({
				payload: {
					...due.payload,
					leaseToken,
					leaseUntilMs,
				},
			})
			.where(eq(revisionOutbox.id, due.id));
		return { id: due.id, payload: due.payload, leaseToken };
	});
}

async function finishDownload(
	database: Database,
	claimed: { id: number; payload: DownloadPayload; leaseToken: string },
	origin: OriginClient,
	stamp: Date,
) {
	if (!(await leaseHeld(database, claimed.id, claimed.leaseToken))) return;
	const current = await publicationPointsAt(database, claimed.payload);
	if (!current) {
		await deleteLeased(database, claimed.id, claimed.leaseToken);
		return;
	}
	let already = await readArtifactReady(
		claimed.payload.revisionId,
		"download",
		database,
	);

	const failures =
		typeof claimed.payload.attempts === "number" ? claimed.payload.attempts : 0;
	const polls =
		typeof claimed.payload.polls === "number" ? claimed.payload.polls : 0;
	let status = 500;
	let busy = false;
	let receipt: DownloadReceipt | undefined;
	const signal = AbortSignal.any([
		AbortSignal.timeout(DOWNLOAD_TRANSFER_MS),
		...(origin.signal ? [origin.signal] : []),
	]);
	try {
		const [revision] = await database
			.select({
				ownerId: videos.ownerId,
				videoId: editRevision.videoId,
				revisionId: editRevision.revisionId,
				generation: editRevision.generation,
				sourceId: editRevision.sourceId,
				metadataSnapshot: editRevision.metadataSnapshot,
			})
			.from(editRevision)
			.innerJoin(videos, eq(videos.id, editRevision.videoId))
			.where(eq(editRevision.revisionId, claimed.payload.revisionId));
		const stored = (
			revision?.metadataSnapshot as { downloadArtifact?: unknown } | null
		)?.downloadArtifact;
		if (
			already === true &&
			revision &&
			verifiedDownloadReceipt(stored, revision)
		) {
			receipt = stored;
			status = 200;
		} else {
			if (!origin.requestDownload) {
				const unavailable = new Error("download origin unavailable");
				unavailable.name = "OriginDownloadUnavailable";
				throw unavailable;
			}
			const response = await origin.requestDownload({
				videoId: claimed.payload.videoId,
				revisionId: claimed.payload.revisionId,
				automatic: true,
				signal,
			});
			status = response.status;
			busy = response.busy === true;
		}
		if (status === 200) {
			if (!revision || revision.videoId !== claimed.payload.videoId)
				throw new Error("DownloadRevisionMissing");
			const { metadataSnapshot, ...identity } = revision;
			if (!receipt) {
				receipt = await persistRevisionDownload({ identity, origin, signal });
				if (
					!(await markRevisionDownloadReady(database, claimed, receipt, true))
				)
					return;
				already = true;
			}
			const snapshot = hlsSnapshot(metadataSnapshot);
			if (!verifiedHlsReceipt(receipt, identity, snapshot)) {
				receipt = {
					...receipt,
					hls: await persistRevisionHls(
						{ identity, origin, signal, includeHls: snapshot },
						receipt.namespace,
					),
				};
			}
			if (!(await markRevisionDownloadReady(database, claimed, receipt)))
				throw new Error("HlsCompletionFenceChanged");
		}
	} catch (error) {
		alertRevisionDownloadFailure({
			videoId: claimed.payload.videoId,
			revisionId: claimed.payload.revisionId,
			reason: downloadFailureClass(error),
		});
		status = 500;
	}
	// Encode-busy is raised only by the origin's slot wait, never by a broken
	// export, so an all-busy round cannot hide a real failure.
	const hardFailure =
		claimed.payload.hardFailure === true ||
		(![200, 202, 409].includes(status) && !busy);
	const plan = planDownloadAttempt({
		current: true,
		originStatus: status,
		failures,
		polls,
		nowMs: stamp.getTime(),
	});
	if (plan.action === "ready") {
		return;
	}
	if (plan.action === "skip") {
		await deleteLeased(database, claimed.id, claimed.leaseToken);
		return;
	}
	if (plan.action === "exhausted" || plan.action === "yield") {
		alertRevisionDownloadFailure({
			videoId: claimed.payload.videoId,
			revisionId: claimed.payload.revisionId,
			reason: "DownloadAttemptsExhausted",
		});
		await database
			.update(revisionArtifactStatus)
			.set({
				state: already === true ? "READY" : "FAILED",
				...(!hardFailure && plan.action !== "yield"
					? {}
					: {
							attempts: await downloadFailedCycle(
								database,
								claimed.payload.revisionId,
							),
						}),
				heartbeatAt: stamp,
				leaseUntil: null,
			})
			.where(
				and(
					eq(revisionArtifactStatus.revisionId, claimed.payload.revisionId),
					eq(revisionArtifactStatus.artifact, "download"),
					sql`EXISTS (SELECT 1 FROM outbox o JOIN video_publication p ON BINARY p.videoId = BINARY o.videoId
						WHERE o.id = ${claimed.id} AND BINARY o.revisionId = BINARY ${claimed.payload.revisionId}
						AND BINARY p.currentRevisionId = BINARY o.revisionId
						AND BINARY JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.leaseToken')) = BINARY ${claimed.leaseToken}
						AND CAST(JSON_UNQUOTE(JSON_EXTRACT(o.payload, '$.leaseUntilMs')) AS UNSIGNED) > UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000)`,
				),
			);
		await deleteLeased(database, claimed.id, claimed.leaseToken);
		return;
	}
	await reschedule(
		database,
		claimed.id,
		claimed.leaseToken,
		{ ...claimed.payload, hardFailure },
		plan,
	);
}

async function downloadFailedCycle(
	database: Database,
	revisionId: string,
): Promise<number> {
	const [row] = await database
		.select({ attempts: revisionArtifactStatus.attempts })
		.from(revisionArtifactStatus)
		.where(
			and(
				eq(revisionArtifactStatus.revisionId, revisionId),
				eq(revisionArtifactStatus.artifact, "download"),
			),
		)
		.limit(1);
	const prior = row?.attempts ?? 0;
	if (prior > DOWNLOAD_MAX_FAILURES) return 1;
	return Math.min(prior + 1, DOWNLOAD_MAX_FAILED_CYCLES);
}

async function enqueueCurrentDownloads(
	database: Database,
	stamp: Date,
	limit: number,
) {
	const cooledBefore = new Date(stamp.getTime() - DOWNLOAD_FAILED_COOLDOWN_MS);
	const pending = await database
		.select({
			revisionId: revisionArtifactStatus.revisionId,
			videoId: videoPublication.videoId,
			state: revisionArtifactStatus.state,
			attempts: revisionArtifactStatus.attempts,
		})
		.from(revisionArtifactStatus)
		.innerJoin(
			videoPublication,
			eq(videoPublication.currentRevisionId, revisionArtifactStatus.revisionId),
		)
		.where(
			and(
				eq(revisionArtifactStatus.artifact, "download"),
				sql`not exists (
					select 1 from ${revisionOutbox}
					where ${revisionOutbox.job} = 'download'
						and ${revisionOutbox.revisionId} = ${revisionArtifactStatus.revisionId}
				)`,
				or(
					eq(revisionArtifactStatus.state, "PENDING"),
					and(
						eq(revisionArtifactStatus.state, "READY"),
						sql`NOT EXISTS (SELECT 1 FROM edit_revision r WHERE BINARY r.revisionId = BINARY ${revisionArtifactStatus.revisionId}
							AND JSON_UNQUOTE(JSON_EXTRACT(r.metadataSnapshot, '$.downloadArtifact.hls.validation')) = 'verified'
							AND BINARY COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.metadataSnapshot, '$.downloadArtifact.hls.snapshot.captionsVtt')), '') = BINARY COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.metadataSnapshot, '$.captionsVtt')), '')
							AND COALESCE(JSON_EXTRACT(r.metadataSnapshot, '$.downloadArtifact.hls.snapshot.chapters'), JSON_ARRAY()) = COALESCE(JSON_EXTRACT(r.metadataSnapshot, '$.chapters'), JSON_ARRAY())
							AND BINARY COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.metadataSnapshot, '$.downloadArtifact.hls.snapshot.thumbnailSha256')), '') = BINARY COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.metadataSnapshot, '$.thumbnailSha256')), ''))`,
						or(
							sql`NOT EXISTS (SELECT 1 FROM edit_revision r WHERE BINARY r.revisionId = BINARY ${revisionArtifactStatus.revisionId} AND JSON_UNQUOTE(JSON_EXTRACT(r.metadataSnapshot, '$.hlsDurabilityStarted')) = 'true')`,
							lt(revisionArtifactStatus.attempts, DOWNLOAD_MAX_FAILED_CYCLES),
						),
						or(
							isNull(revisionArtifactStatus.heartbeatAt),
							lte(revisionArtifactStatus.heartbeatAt, cooledBefore),
						),
					),
					and(
						eq(revisionArtifactStatus.state, "FAILED"),
						or(
							isNull(revisionArtifactStatus.heartbeatAt),
							lte(revisionArtifactStatus.heartbeatAt, cooledBefore),
						),
						or(
							lt(revisionArtifactStatus.attempts, DOWNLOAD_MAX_FAILED_CYCLES),
							gt(revisionArtifactStatus.attempts, DOWNLOAD_MAX_FAILURES),
						),
					),
				),
			),
		)
		.limit(limit);
	for (const row of pending) {
		if (row.state === "READY") {
			await database.execute(sql`
				UPDATE edit_revision r
				JOIN revision_artifact_status a ON BINARY a.revisionId = BINARY r.revisionId AND a.artifact = 'download'
				SET r.metadataSnapshot = JSON_SET(COALESCE(r.metadataSnapshot, JSON_OBJECT()), '$.downloadDurabilityStarted', CAST('true' AS JSON), '$.hlsDurabilityStarted', CAST('true' AS JSON)), a.attempts = 0
				WHERE BINARY r.revisionId = BINARY ${row.revisionId} AND a.state = 'READY'
					AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(r.metadataSnapshot, '$.hlsDurabilityStarted')), '') <> 'true'
			`);
		}
		if (row.state === "FAILED") {
			await database
				.update(revisionArtifactStatus)
				.set({
					state: "PENDING",
					leaseUntil: null,
					...(row.attempts > DOWNLOAD_MAX_FAILURES ? { attempts: 0 } : {}),
				})
				.where(
					and(
						eq(revisionArtifactStatus.revisionId, row.revisionId),
						eq(revisionArtifactStatus.artifact, "download"),
						eq(revisionArtifactStatus.state, "FAILED"),
					),
				);
		}
		const [existing] = await database
			.select({ id: revisionOutbox.id })
			.from(revisionOutbox)
			.where(
				and(
					eq(revisionOutbox.job, "download"),
					eq(revisionOutbox.revisionId, row.revisionId),
				),
			)
			.limit(1);
		if (existing) continue;
		await database.insert(revisionOutbox).values({
			videoId: row.videoId,
			revisionId: row.revisionId,
			job: "download",
			payload: {
				job: "download",
				revisionId: row.revisionId,
				videoId: row.videoId,
			},
			createdAt: stamp,
		});
	}
}

let downloadInFlight: Promise<void> | null = null;

export function pendingRevisionDownloads(): Promise<void> {
	return downloadInFlight ?? Promise.resolve();
}

export function sweepRevisionDownloads(
	...args: Parameters<typeof drainRevisionDownloads>
): Promise<void> {
	if (!downloadInFlight) {
		// Publication readback shares this tick; a slow export must not hold it.
		const run = drainRevisionDownloads(...args);
		downloadInFlight = run;
		const clear = () => {
			if (downloadInFlight === run) downloadInFlight = null;
		};
		void run.then(clear, clear);
	}
	return Promise.resolve();
}

export async function drainRevisionDownloads(
	database: unknown,
	input: { origin: OriginClient; now?: Date; limit?: number },
): Promise<void> {
	const app = database as Database;
	const stamp = input.now ?? new Date();
	const limit = input.limit ?? 4;
	try {
		await enqueueCurrentDownloads(app, stamp, limit);
	} catch (error) {
		alertRevisionDownloadFailure({
			videoId: "unknown",
			revisionId: "unknown",
			reason: downloadFailureClass(error),
		});
	}
	for (let index = 0; index < limit; index += 1) {
		try {
			const claimed = await claimDueDownload(app, input.now ?? new Date());
			if (!claimed) return;
			await finishDownload(app, claimed, input.origin, stamp);
		} catch (error) {
			alertRevisionDownloadFailure({
				videoId: "unknown",
				revisionId: "unknown",
				reason: downloadFailureClass(error),
			});
			return;
		}
	}
}

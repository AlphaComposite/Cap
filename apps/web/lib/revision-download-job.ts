import type { db } from "@cap/database";
import {
	editRevision,
	revisionArtifactStatus,
	revisionOutbox,
	videoPublication,
} from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { readArtifactReady } from "@/lib/revision-media-grant";
import type { OriginClient } from "@/lib/revision-publication-origin";
import { revisionSnapshotKeySql } from "@/lib/revision-snapshot-patch";

type Database = ReturnType<typeof db>;

export const DOWNLOAD_MAX_FAILURES = 8;
export const DOWNLOAD_MAX_POLLS = 240;
const DOWNLOAD_LEASE_MS = 20_000;
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
	| { action: "exhausted"; failures: number };

type DownloadPayload = {
	job: "download";
	revisionId: string;
	videoId: string;
	attempts?: number;
	polls?: number;
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
	if (!input.current) return { action: "skip" };
	if (input.originStatus === 200) return { action: "ready" };
	if (input.originStatus === 202) {
		const polls = input.polls + 1;
		if (polls > DOWNLOAD_MAX_POLLS) {
			return { action: "exhausted", failures: input.failures };
		}
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
	const payload = row?.payload as { leaseToken?: string } | undefined;
	return payload?.leaseToken === leaseToken;
}

export async function markRevisionDownloadReady(
	database: Database,
	revisionId: string,
	stamp: Date,
) {
	await database
		.update(revisionArtifactStatus)
		.set({
			state: "READY",
			heartbeatAt: stamp,
			leaseUntil: null,
		})
		.where(
			and(
				eq(revisionArtifactStatus.revisionId, revisionId),
				eq(revisionArtifactStatus.artifact, "download"),
			),
		);
	const [revision] = await database
		.select({ metadataSnapshot: editRevision.metadataSnapshot })
		.from(editRevision)
		.where(eq(editRevision.revisionId, revisionId));
	if (!revision?.metadataSnapshot) return;
	if (revision.metadataSnapshot.downloadReady === true) return;
	await database
		.update(editRevision)
		.set({
			metadataSnapshot: revisionSnapshotKeySql("downloadReady"),
			updatedAt: stamp,
		})
		.where(eq(editRevision.revisionId, revisionId));
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
	const already = await readArtifactReady(
		claimed.payload.revisionId,
		"download",
		database,
	);
	if (already === true) {
		await markRevisionDownloadReady(
			database,
			claimed.payload.revisionId,
			stamp,
		);
		await deleteLeased(database, claimed.id, claimed.leaseToken);
		return;
	}
	const failures =
		typeof claimed.payload.attempts === "number" ? claimed.payload.attempts : 0;
	const polls =
		typeof claimed.payload.polls === "number" ? claimed.payload.polls : 0;
	let status = 500;
	try {
		if (!origin.requestDownload) {
			const unavailable = new Error("download origin unavailable");
			unavailable.name = "OriginDownloadUnavailable";
			throw unavailable;
		}
		const response = await origin.requestDownload({
			videoId: claimed.payload.videoId,
			revisionId: claimed.payload.revisionId,
		});
		status = response.status;
	} catch (error) {
		alertRevisionDownloadFailure({
			videoId: claimed.payload.videoId,
			revisionId: claimed.payload.revisionId,
			reason: downloadFailureClass(error),
		});
		status = 500;
	}
	const plan = planDownloadAttempt({
		current: true,
		originStatus: status,
		failures,
		polls,
		nowMs: stamp.getTime(),
	});
	if (plan.action === "ready") {
		await markRevisionDownloadReady(
			database,
			claimed.payload.revisionId,
			stamp,
		);
		await deleteLeased(database, claimed.id, claimed.leaseToken);
		return;
	}
	if (plan.action === "skip") {
		await deleteLeased(database, claimed.id, claimed.leaseToken);
		return;
	}
	if (plan.action === "exhausted") {
		alertRevisionDownloadFailure({
			videoId: claimed.payload.videoId,
			revisionId: claimed.payload.revisionId,
			reason: "DownloadAttemptsExhausted",
		});
		await database
			.update(revisionArtifactStatus)
			.set({
				state: "FAILED",
				attempts: plan.failures,
				heartbeatAt: stamp,
				leaseUntil: null,
			})
			.where(
				and(
					eq(revisionArtifactStatus.revisionId, claimed.payload.revisionId),
					eq(revisionArtifactStatus.artifact, "download"),
				),
			);
		await deleteLeased(database, claimed.id, claimed.leaseToken);
		return;
	}
	await reschedule(
		database,
		claimed.id,
		claimed.leaseToken,
		claimed.payload,
		plan,
	);
}

async function enqueueCurrentDownloads(
	database: Database,
	stamp: Date,
	limit: number,
) {
	const pending = await database
		.select({
			revisionId: revisionArtifactStatus.revisionId,
			videoId: videoPublication.videoId,
		})
		.from(revisionArtifactStatus)
		.innerJoin(
			videoPublication,
			eq(videoPublication.currentRevisionId, revisionArtifactStatus.revisionId),
		)
		.where(
			and(
				eq(revisionArtifactStatus.artifact, "download"),
				eq(revisionArtifactStatus.state, "PENDING"),
				sql`not exists (
					select 1 from ${revisionOutbox}
					where ${revisionOutbox.job} = 'download'
						and ${revisionOutbox.revisionId} = ${revisionArtifactStatus.revisionId}
				)`,
			),
		)
		.limit(limit);
	for (const row of pending) {
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

export async function sweepRevisionDownloads(
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
			const claimed = await claimDueDownload(app, stamp);
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

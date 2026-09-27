import { db } from "@cap/database";
import { editRevision } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";

export const PUBLISH_JOINED_PREPARE = "publish-joined";

const runningOriginPrepares = new Set<string>();

type InflightState = {
	state: string;
	error: string | null;
};

export function trackOriginPrepare(revisionId: string): () => void {
	runningOriginPrepares.add(revisionId);
	return () => {
		runningOriginPrepares.delete(revisionId);
	};
}

export function originPrepareIsRunning(revisionId: string): boolean {
	return runningOriginPrepares.has(revisionId);
}

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

export function abortedPrepareShouldFail(row: InflightState): boolean {
	if (row.error === PUBLISH_JOINED_PREPARE) return false;
	return row.state === "COMMITTED_INTENT" || row.state === "PREPARING";
}

function videoId(value: string): Video.VideoId {
	return value as Video.VideoId;
}

async function inflightRows(input: { videoId: string; revisionId?: string }) {
	const revision = input.revisionId
		? eq(editRevision.revisionId, input.revisionId)
		: eq(editRevision.videoId, videoId(input.videoId));
	return db()
		.select({
			revisionId: editRevision.revisionId,
			state: editRevision.state,
			error: editRevision.error,
		})
		.from(editRevision)
		.where(
			and(
				revision,
				sql`${editRevision.state} in ('COMMITTED_INTENT','PREPARING')`,
			),
		);
}

export async function failUnjoinedInflightPrepare(input: {
	videoId: string;
	revisionId?: string;
}): Promise<{ markedFailed: boolean; joined: boolean }> {
	const rows = await inflightRows(input);
	if (rows.some((row) => row.error === PUBLISH_JOINED_PREPARE)) {
		return { markedFailed: false, joined: true };
	}
	if (rows.some((row) => originPrepareIsRunning(row.revisionId))) {
		return { markedFailed: false, joined: false };
	}
	const revision = input.revisionId
		? eq(editRevision.revisionId, input.revisionId)
		: eq(editRevision.videoId, videoId(input.videoId));
	const updated = await db()
		.update(editRevision)
		.set({
			state: "FAILED",
			error: "client aborted",
			updatedAt: new Date(),
		})
		.where(
			and(
				revision,
				sql`${editRevision.state} in ('COMMITTED_INTENT','PREPARING')`,
				sql`(${editRevision.error} is null or ${editRevision.error} <> ${PUBLISH_JOINED_PREPARE})`,
			),
		);
	return { markedFailed: affectedRows(updated) > 0, joined: false };
}

import { db } from "@cap/database";
import { videoEdits } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { resolveLegacySourceKey } from "@/lib/source-relocation";

export const PRIVATE_SOURCE_CACHE_CONTROL = "private, no-store";

type SqlExecutor = {
	execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

const rowsOf = (result: unknown) => {
	if (Array.isArray(result)) {
		return Array.isArray(result[0]) ? result[0] : result;
	}
	const rows = (result as { rows?: unknown[] }).rows;
	return rows ?? [];
};

export async function resolveLiveOriginal(
	videoId: string,
	executor: SqlExecutor = db(),
): Promise<{ liveKey: string; sha256: string } | null> {
	try {
		const result = await executor.execute(sql`
			SELECT liveKey, sha256
			FROM source_object
			WHERE videoId = ${videoId}
			LIMIT 1
		`);
		const row = rowsOf(result)[0] as
			| { liveKey?: string; sha256?: string }
			| undefined;
		if (!row?.liveKey || !row.sha256) return null;
		return { liveKey: row.liveKey, sha256: row.sha256 };
	} catch (error) {
		const record = error as { errno?: number; code?: string; cause?: unknown };
		if (record.errno === 1146 || record.code === "ER_NO_SUCH_TABLE")
			return null;
		const cause = record.cause as { errno?: number; code?: string } | undefined;
		if (cause?.errno === 1146 || cause?.code === "ER_NO_SUCH_TABLE")
			return null;
		throw error;
	}
}

export async function mapLegacySourceKey(videoId: string, sourceKey: string) {
	const live = await resolveLiveOriginal(videoId);
	let relocations: Array<{
		oldKey: string;
		newKey: string;
		state: "INTENT" | "COPIED" | "POINTER" | "DELETED" | "PURGED" | "ABORTED";
	}> = [];
	try {
		const result = await db().execute(sql`
			SELECT oldKey, newKey, state
			FROM source_relocation
			WHERE videoId = ${videoId} AND oldKey = ${sourceKey}
		`);
		relocations = rowsOf(result) as typeof relocations;
	} catch (error) {
		const record = error as { errno?: number; code?: string };
		if (record.errno !== 1146 && record.code !== "ER_NO_SUCH_TABLE")
			throw error;
	}
	return resolveLegacySourceKey({
		sourceKey,
		liveKey: live?.liveKey ?? null,
		relocations,
	});
}

export async function ownerOriginalObjectKey(
	videoId: Video.VideoId,
	ownerId: string,
) {
	const live = await resolveLiveOriginal(videoId);
	if (live) return live.liveKey;
	const [edit] = await db()
		.select({ sourceKey: videoEdits.sourceKey })
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId));
	if (edit?.sourceKey) return mapLegacySourceKey(videoId, edit.sourceKey);
	return `${ownerId}/${videoId}/source/original.mp4`;
}

export function privateSourceHeaders(extra?: HeadersInit) {
	const headers = new Headers(extra);
	headers.set("Cache-Control", PRIVATE_SOURCE_CACHE_CONTROL);
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("X-Content-Type-Options", "nosniff");
	return headers;
}

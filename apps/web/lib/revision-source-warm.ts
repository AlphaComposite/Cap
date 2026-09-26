export type WarmSource = {
	sourceKey: string;
	sha256: string;
	codec: string;
	timebase: string;
	frameMode: "vfr" | "cfr";
	a1Digest: string;
	indexId: string;
	warmExpiresAt: string;
};

export function warmSourceFromRow(
	row: {
		liveKey: string;
		sha256: string;
		relocationState: string;
		codec: string | null;
		timebase: string | null;
		frameMode: string | null;
		a1Digest: string | null;
		indexId: string | null;
		warmExpiresAt: Date | null;
	} | null,
	now: Date,
): WarmSource | null {
	if (
		!row ||
		row.relocationState !== "LIVE" ||
		!row.codec ||
		!row.timebase ||
		(row.frameMode !== "vfr" && row.frameMode !== "cfr") ||
		!row.a1Digest ||
		!row.indexId ||
		!row.warmExpiresAt ||
		row.warmExpiresAt.getTime() <= now.getTime()
	) {
		return null;
	}
	return {
		sourceKey: row.liveKey,
		sha256: row.sha256,
		codec: row.codec,
		timebase: row.timebase,
		frameMode: row.frameMode,
		a1Digest: row.a1Digest,
		indexId: row.indexId,
		warmExpiresAt: row.warmExpiresAt.toISOString(),
	};
}

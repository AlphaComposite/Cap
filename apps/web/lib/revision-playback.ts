import type { InstantFinishPublicationDto } from "./revision-publication-read";

export const REVISION_HLS_CONTENT_TYPE = "application/vnd.apple.mpegurl";

export type RevisionPlaybackMode = "legacy" | "hls" | "unavailable";

export type SharePlaybackPlan = {
	prefetchResultMp4: boolean;
	player: RevisionPlaybackMode;
	omitRawFallback: boolean;
	blockProcessingOverlay: boolean;
};

export type ClientRevisionPlayback =
	| {
			mode: "hls";
			videoId: string;
			revisionId: string;
			generation: number;
			playlistUrl: string;
			duration: number | null;
			captionsUrl: string | null;
			chapters: { title: string; start: number }[] | null;
			commentTimestamps: Record<string, number | null> | null;
			thumbnailUrl: string | null;
			downloadReady: boolean;
	  }
	| {
			mode: "unavailable";
			videoId: string;
			generation: number;
			downloadReady: false;
	  };

export function planSharePlayback(input: {
	enabled: boolean;
	currentRevisionId: string | null;
	isScreenshot: boolean;
	hasActiveUpload: boolean;
	sourceType: string;
	eligibleLegacy?: boolean;
}): SharePlaybackPlan {
	if (!input.enabled || (input.eligibleLegacy && !input.currentRevisionId)) {
		const isMp4 =
			input.sourceType === "desktopMP4" || input.sourceType === "webMP4";
		return {
			prefetchResultMp4: isMp4 && !input.isScreenshot && !input.hasActiveUpload,
			player: "legacy",
			omitRawFallback: false,
			blockProcessingOverlay: false,
		};
	}
	return {
		prefetchResultMp4: false,
		player: input.currentRevisionId ? "hls" : "unavailable",
		omitRawFallback: true,
		blockProcessingOverlay: false,
	};
}

export function revisionMediaPath(
	videoId: string,
	revisionId: string,
	asset: string,
): string {
	return `/media/${videoId}/r/${revisionId}/${asset}`;
}

export function buildRevisionAssetUrl(input: {
	origin: string;
	videoId: string;
	revisionId: string;
	asset: string;
	grant: string;
}): string {
	const path = revisionMediaPath(input.videoId, input.revisionId, input.asset);
	const base = input.origin ? new URL(path, input.origin).toString() : path;
	const url = new URL(base, "http://revision.local");
	url.searchParams.set("t", input.grant);
	if (!input.origin) {
		return `${path}?${url.searchParams.toString()}`;
	}
	return url.toString();
}

export function publicRevisionPlaylistUrl(input: {
	origin: string;
	videoId: string;
	revisionId: string;
}): string {
	const path = revisionMediaPath(
		input.videoId,
		input.revisionId,
		"playlist.m3u8",
	);
	return input.origin ? new URL(path, input.origin).toString() : path;
}

export function redactMediaGrant(url: string): string {
	return url.replace(/([?&]t=)[^&]*/g, "$1[redacted]");
}

export function replacePlaylistGrant(url: string, grant: string): string {
	const parsed = new URL(url, "http://revision.local");
	parsed.searchParams.set("t", grant);
	if (url.startsWith("http://") || url.startsWith("https://")) {
		return parsed.toString();
	}
	return `${parsed.pathname}?${parsed.searchParams.toString()}`;
}

/** Renew the playback grant when less than this many seconds of its life remain. */
export const GRANT_RENEW_LEAD_S = 20;

function grantLifetimeS(grant: string): number | null {
	const payload = grant.split(".")[1];
	if (!payload) return null;
	try {
		const json = JSON.parse(
			atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
		) as { iat?: unknown; exp?: unknown };
		return typeof json.iat === "number" && typeof json.exp === "number"
			? json.exp - json.iat
			: null;
	} catch {
		return null;
	}
}

export function mediaGrantOf(url: string): string | null {
	return new URL(url, "http://revision.local").searchParams.get("t");
}

/**
 * Holds the current playback grant and renews it on demand. Freshness is measured
 * from when this browser received the grant (exp - iat lifetime), so a skewed
 * viewer clock is harmless. Because renewal happens at request time, pauses,
 * sleep, background tabs and network drops all recover without a 401.
 */
export function createGrantKeeper(input: {
	grant: string;
	renew: () => Promise<string | null>;
	now?: () => number;
}) {
	const now = input.now ?? Date.now;
	let grant = input.grant;
	let receivedAt = now();
	let inflight: Promise<string> | null = null;
	const stale = () => {
		const life = grantLifetimeS(grant) ?? 60;
		return now() - receivedAt >= Math.max(0, life - GRANT_RENEW_LEAD_S) * 1000;
	};
	return {
		current: () => grant,
		stale,
		/** Fresh grant; renews once (shared by concurrent callers) when near expiry. */
		async fresh(): Promise<string> {
			if (!stale()) return grant;
			inflight ??= input
				.renew()
				.then((next) => {
					if (next) {
						grant = next;
						receivedAt = now();
					}
					return grant;
				})
				.catch(() => grant)
				.finally(() => {
					inflight = null;
				});
			return inflight;
		},
	};
}

/**
 * hls.js loader that waits for a fresh grant and stamps it on every /media/
 * request carrying one, so the player never needs rebuilding for a new grant.
 */
export function createGrantLoader<T extends new (...args: never[]) => object>(
	Base: T,
	keeper: { fresh: () => Promise<string> },
): T {
	const Wrapped = class extends (Base as new (
		...args: never[]
	) => { load(...args: never[]): void; abort?(): void }) {
		private aborted = false;
		abort() {
			this.aborted = true;
			super.abort?.();
		}
		load(...args: never[]) {
			const context = args[0] as unknown as { url?: unknown };
			const url = typeof context?.url === "string" ? context.url : "";
			if (!url.includes("/media/") || mediaGrantOf(url) === null) {
				super.load(...args);
				return;
			}
			this.aborted = false;
			void keeper.fresh().then((grant) => {
				if (this.aborted) return;
				(context as { url: string }).url = replacePlaylistGrant(url, grant);
				super.load(...args);
			});
		}
	};
	return Wrapped as unknown as T;
}

export function buildClientRevisionPlayback(input: {
	publication: InstantFinishPublicationDto;
	videoId: string;
	origin: string;
	grant: string | null;
	eligibleLegacy?: boolean;
}): ClientRevisionPlayback | null {
	if (!input.publication.enabled) return null;
	if (input.eligibleLegacy && !input.publication.currentRevisionId) return null;
	if (!input.publication.currentRevisionId || !input.grant) {
		return {
			mode: "unavailable",
			videoId: input.videoId,
			generation: input.publication.generation,
			downloadReady: false,
		};
	}
	const revisionId = input.publication.currentRevisionId;
	const metadata = input.publication.revisionMetadata;
	const assetUrl = (asset: string) =>
		buildRevisionAssetUrl({
			origin: input.origin,
			videoId: input.videoId,
			revisionId,
			asset,
			grant: input.grant as string,
		});
	return {
		mode: "hls",
		videoId: input.videoId,
		revisionId,
		generation: input.publication.generation,
		playlistUrl: assetUrl("playlist.m3u8"),
		duration: metadata?.duration ?? input.publication.duration,
		captionsUrl: metadata?.captionsAvailable ? assetUrl("captions.vtt") : null,
		chapters: metadata?.chapters ?? null,
		commentTimestamps: metadata?.commentTimestamps ?? null,
		thumbnailUrl: metadata?.thumbnailAvailable
			? assetUrl("thumbnail.jpg")
			: null,
		downloadReady: metadata?.downloadReady === true,
	};
}

export function applyRevisionCommentTimes<
	T extends { id: string; timestamp: number | null },
>(comments: T[], timestamps: Record<string, number | null> | null): T[] {
	return comments.map((comment) => {
		if (!timestamps || !Object.hasOwn(timestamps, comment.id)) {
			return { ...comment, timestamp: null };
		}
		const timestamp = timestamps[comment.id];
		return {
			...comment,
			timestamp: typeof timestamp === "number" ? timestamp : null,
		};
	});
}

export type GrantRefreshPlan =
	| "reload-same"
	| "refresh-page"
	| "hold"
	| "fail-closed";

export function shareCanDownload(input: {
	playback: { mode: RevisionPlaybackMode } | null;
	permitted: boolean;
}): boolean {
	if (!input.permitted) return false;
	if (!input.playback) return true;
	return input.playback.mode === "hls";
}

export function hlsResumePosition(currentTime: number): number {
	if (!Number.isFinite(currentTime) || currentTime <= 0) return -1;
	return currentTime;
}

export function grantResumeStartPosition(currentTime: number): number {
	const resumeAt = hlsResumePosition(currentTime);
	return resumeAt > 0 ? resumeAt : -1;
}

export function playbackResumeTime(
	lastPositive: number,
	currentTime: number,
): number {
	if (Number.isFinite(currentTime) && currentTime > 0.5) return currentTime;
	if (Number.isFinite(lastPositive) && lastPositive > 0.5) return lastPositive;
	return currentTime;
}

export type GrantRefreshCycle = {
	inFlight: boolean;
	attempts: number;
};

export function beginGrantRefreshCycle(
	cycle: GrantRefreshCycle,
	maxAttempts: number,
): {
	cycle: GrantRefreshCycle;
	action: "refresh" | "coalesce" | "fail-closed";
} {
	if (cycle.inFlight) return { cycle, action: "coalesce" };
	if (cycle.attempts >= maxAttempts) {
		return { cycle, action: "fail-closed" };
	}
	return {
		cycle: { inFlight: true, attempts: cycle.attempts + 1 },
		action: "refresh",
	};
}

export function settleGrantRefreshCycle(
	cycle: GrantRefreshCycle,
	fragmentLoaded: boolean,
): GrantRefreshCycle {
	return {
		inFlight: false,
		attempts: fragmentLoaded ? 0 : cycle.attempts,
	};
}

export function revisionHlsErrorAction(input: {
	status?: number;
	fatal?: boolean;
	details?: string;
	refreshAttempts: number;
	maxRefreshAttempts: number;
	policyDenied: boolean;
	native?: boolean;
}):
	| { type: "refresh-grant" }
	| { type: "stop" }
	| { type: "fail-closed" }
	| { type: "ignore" } {
	if (input.policyDenied) return { type: "fail-closed" };
	const status = input.status ?? 0;
	if (status === 403) return { type: "stop" };
	if (input.refreshAttempts >= input.maxRefreshAttempts) {
		return { type: "fail-closed" };
	}
	if (
		input.native === true ||
		status === 401 ||
		status === 410 ||
		status >= 500
	) {
		return { type: "refresh-grant" };
	}
	return { type: "ignore" };
}

export function replayRevisionHlsEvents(
	events: Array<{
		status?: number;
		native?: boolean;
		policyDenied?: boolean;
	}>,
	maxRefreshAttempts = 2,
) {
	let refreshAttempts = 0;
	let policyDenied = false;
	return events.map((event) => {
		const action = revisionHlsErrorAction({
			status: event.status,
			fatal: true,
			refreshAttempts,
			maxRefreshAttempts,
			policyDenied: policyDenied || event.policyDenied === true,
			native: event.native,
		});
		if (action.type === "refresh-grant") refreshAttempts += 1;
		if (action.type === "fail-closed") policyDenied = true;
		return action;
	});
}

export function planGrantRefresh(input: {
	status: number;
	revisionId: string;
	body: { revisionId?: string; changed?: boolean; grant?: string } | null;
}): GrantRefreshPlan {
	if (input.status === 410 || input.body?.changed === true)
		return "refresh-page";
	if (
		input.status === 200 &&
		input.body?.revisionId &&
		input.body.revisionId !== input.revisionId
	) {
		return "refresh-page";
	}
	if (
		input.status === 200 &&
		input.body?.revisionId === input.revisionId &&
		typeof input.body.grant === "string" &&
		input.body.grant.length > 0
	) {
		return "reload-same";
	}
	return "hold";
}

export function filmstripForRevision(
	playback: ClientRevisionPlayback | null,
	legacy: { src: string; kind: "native" | "hls" } | null,
): { src: string; kind: "native" | "hls" } | null {
	if (!playback) return legacy;
	if (playback.mode === "unavailable") return null;
	return { src: playback.playlistUrl, kind: "hls" };
}

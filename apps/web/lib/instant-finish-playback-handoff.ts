import type { ClientRevisionPlayback } from "./revision-playback";
import type { InstantFinishPublicationDto } from "./revision-publication-read";

export const INSTANT_FINISH_PLAYBACK_KEY = "cap:instant-finish-playback";

export type InstantFinishPlaybackPayload = {
	playlistUrl: string;
	grantExpiresAt: number;
	revisionMetadata: InstantFinishPublicationDto["revisionMetadata"];
};

export type StashedInstantFinishPlayback = InstantFinishPlaybackPayload & {
	videoId: string;
	revisionId: string;
	generation: number;
};

type HandoffStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isMetadata(
	value: unknown,
): value is InstantFinishPublicationDto["revisionMetadata"] {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.playlistPath === "string" || record.playlistPath === null
	);
}

function parseStash(raw: string | null): StashedInstantFinishPlayback | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<StashedInstantFinishPlayback>;
		if (
			typeof parsed.videoId !== "string" ||
			typeof parsed.revisionId !== "string" ||
			typeof parsed.playlistUrl !== "string" ||
			!parsed.playlistUrl.includes("t=") ||
			typeof parsed.grantExpiresAt !== "number" ||
			!Number.isFinite(parsed.grantExpiresAt) ||
			!isMetadata(parsed.revisionMetadata)
		) {
			return null;
		}
		return parsed as StashedInstantFinishPlayback;
	} catch {
		return null;
	}
}

export function stashInstantFinishPlayback(
	payload: StashedInstantFinishPlayback,
	storage: Pick<Storage, "setItem">,
): void {
	storage.setItem(INSTANT_FINISH_PLAYBACK_KEY, JSON.stringify(payload));
}

export function prefetchInstantFinishPlaylist(url: string): void {
	if (typeof fetch !== "function" || !url.includes("t=")) return;
	void fetch(url, { credentials: "same-origin", cache: "no-store" }).catch(
		() => undefined,
	);
}

export function preferInstantFinishFirstPaint(input: {
	videoId: string;
	ssr: ClientRevisionPlayback | null;
	storage: HandoffStorage | null;
	nowMs: number;
}): { playback: ClientRevisionPlayback | null; fromHandoff: boolean } {
	const stashed = parseStash(
		input.storage?.getItem(INSTANT_FINISH_PLAYBACK_KEY) ?? null,
	);
	const expired =
		stashed != null && stashed.grantExpiresAt * 1000 <= input.nowMs;
	const matches =
		stashed != null &&
		!expired &&
		stashed.videoId === input.videoId &&
		input.ssr?.mode === "hls" &&
		input.ssr.revisionId === stashed.revisionId;
	if (!matches || !stashed || input.ssr?.mode !== "hls") {
		return { playback: input.ssr, fromHandoff: false };
	}
	return {
		fromHandoff: true,
		playback: {
			...input.ssr,
			playlistUrl: stashed.playlistUrl,
			duration: stashed.revisionMetadata.duration ?? input.ssr.duration,
			chapters: stashed.revisionMetadata.chapters,
		},
	};
}

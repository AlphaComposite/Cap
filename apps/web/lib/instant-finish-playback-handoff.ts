import { registerInflightFragment } from "./instant-finish-fragment-cache";
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

export function instantFinishStartupUrls(
	playlistUrl: string,
	playlist: string,
): string[] {
	const base = new URL(playlistUrl, "http://cap.local");
	const prefix = base.pathname.replace(/\/[^/]*$/, "/");
	const urls: string[] = [];
	const push = (raw: string) => {
		const resolved = new URL(raw, base);
		if (
			resolved.origin !== base.origin ||
			!resolved.pathname.startsWith(prefix)
		) {
			return;
		}
		const path = `${resolved.pathname}${resolved.search}`;
		if (!urls.includes(path)) urls.push(path);
	};
	for (const line of playlist.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#EXT-X-MAP:")) {
			const match = /URI="([^"]+)"/.exec(trimmed);
			if (match?.[1]) push(match[1]);
		} else if (trimmed && !trimmed.startsWith("#")) {
			push(trimmed);
		}
		if (urls.length >= 3) break;
	}
	return urls;
}

export function prefetchInstantFinishPlaylist(url: string): void {
	if (typeof fetch !== "function" || !url.includes("t=")) return;
	// Prepare writes a tiny seg0. Chromium will not paint until the next
	// fragment is appended, and that encode is cold unless it starts here.
	const playlist = fetch(url, { credentials: "same-origin" }).then(
		async (response) => {
			if (!response.ok) throw new Error("prefetch failed");
			return response.arrayBuffer();
		},
	);
	registerInflightFragment(url, playlist);
	void playlist
		.then(async (bytes) => {
			const assets = instantFinishStartupUrls(
				url,
				new TextDecoder().decode(bytes),
			);
			await Promise.all(
				assets.map(async (asset) => {
					let resolveBytes: (bytes: ArrayBuffer) => void = () => {};
					let rejectBytes: (error: unknown) => void = () => {};
					const pending = new Promise<ArrayBuffer>((resolve, reject) => {
						resolveBytes = resolve;
						rejectBytes = reject;
					});
					registerInflightFragment(asset, pending);
					try {
						const item = await fetch(asset, { credentials: "same-origin" });
						if (!item.ok) {
							rejectBytes(new Error("prefetch failed"));
							return;
						}
						resolveBytes(await item.arrayBuffer());
					} catch (error) {
						rejectBytes(error);
					}
				}),
			);
		})
		.catch(() => undefined);
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
	if (expired) input.storage?.removeItem(INSTANT_FINISH_PLAYBACK_KEY);
	const matches =
		stashed != null &&
		!expired &&
		stashed.videoId === input.videoId &&
		input.ssr?.mode === "hls" &&
		input.ssr.revisionId === stashed.revisionId;
	if (!matches || !stashed || input.ssr?.mode !== "hls") {
		return { playback: input.ssr, fromHandoff: false };
	}
	input.storage?.removeItem(INSTANT_FINISH_PLAYBACK_KEY);
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

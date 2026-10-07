import {
	PEAKS_CACHE_CONTROL,
	PEAKS_CONTENT_TYPE,
	peaksObjectKey,
} from "@/lib/waveform-peaks";

export type PeaksAccess =
	| { status: 200; key: string; sha256: string }
	| { status: 401 | 403 | 404 | 410 };

export function authorizePeaksRead(input: {
	userId: string | null;
	ownerId: string | null;
	videoFound: boolean;
	flagged: boolean;
	registeredSha: string | null;
	videoId: string;
}): PeaksAccess {
	if (!input.userId) return { status: 401 };
	if (!input.videoFound || !input.ownerId) return { status: 410 };
	if (input.userId !== input.ownerId) return { status: 403 };
	if (!input.flagged || !input.registeredSha) return { status: 404 };
	const key = peaksObjectKey(input.videoId, input.registeredSha);
	if (!key) return { status: 404 };
	return { status: 200, key, sha256: input.registeredSha };
}

export function peaksReadHeaders(): Headers {
	const headers = new Headers();
	headers.set("Cache-Control", PEAKS_CACHE_CONTROL);
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Content-Type", PEAKS_CONTENT_TYPE);
	headers.set("Vary", "Cookie");
	return headers;
}

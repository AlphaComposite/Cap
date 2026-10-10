import { createHash } from "node:crypto";
import type { VideoEditSpecV2 } from "@cap/database/types";
import { Agent, fetch as originFetch } from "undici";
import {
	ORIGIN_ATTESTATION_HEADER,
	ORIGIN_SERVICE_HEADER,
	signInternalServiceRequest,
} from "@/lib/revision-media-token";
import { sha256Hex } from "@/lib/revision-publication-metadata";

export const INTERNAL_TOKEN_HEADER = ORIGIN_SERVICE_HEADER;

export type SourcePrepareBody = {
	videoId: string;
	sourceId: string;
	sourceKey: string;
};

export type SourcePrepareResult = {
	sourceKey: string;
	sha256: string;
	codec: string;
	timebase: string;
	frameMode: "vfr" | "cfr";
	a1Digest: string;
	indexId: string;
	warmExpiresAt: string;
};

export type RevisionPrepareBody = {
	videoId: string;
	revisionId: string;
	intentId: string;
	sourceId: string;
	sourceKey?: string;
	generation: number;
	durationSeconds: number;
	keepRanges: { start: number; end: number }[];
	editSpec: VideoEditSpecV2;
	captionsVtt: string;
	chaptersJson: string;
	thumbnailPolicy: "source-zero" | "seg0-first-frame";
};

export type RevisionPrepareResult = {
	ready: boolean;
	intentId: string;
	durationSeconds: number;
	durationTicks?: number;
	segmentCount?: number;
	seg0DecodedFrames: number;
	encoderHash?: string;
	segmentPlanVersion?: number;
	playlistHasEndList: boolean;
	decoded: boolean;
	decodedFrames: number;
	initSha256: string;
	seg0Sha256: string;
	playlistDurationSeconds: number;
	attestationMac: string;
	attestationBody: string;
};

export type OriginArtifact = {
	status: number;
	body: Buffer;
	contentType: string | null;
};

export type FrameSelectionRequest = {
	videoId: string;
	sourceId: string;
	sourceSha256: string;
	a1Digest: string;
	indexId: string;
	keepRanges: { start: number; end: number }[];
};

export type FrameSelectionResult = {
	sourceId: string;
	sourceSha256: string;
	a1Digest: string;
	indexId: string;
	keepIndexes: number[];
	keepRanges: { start: number; end: number }[];
};

const SHA64 = /^[a-f0-9]{64}$/;

export function assertFrameSelection(
	requested: FrameSelectionRequest,
	response: unknown,
): { start: number; end: number }[] {
	if (!response || typeof response !== "object") {
		throw new Error("Frame selection response is malformed");
	}
	const payload = response as Record<string, unknown>;
	if (
		typeof payload.sourceId !== "string" ||
		typeof payload.sourceSha256 !== "string" ||
		typeof payload.a1Digest !== "string" ||
		typeof payload.indexId !== "string" ||
		!Array.isArray(payload.keepIndexes) ||
		!Array.isArray(payload.keepRanges)
	) {
		throw new Error("Frame selection response is malformed");
	}
	if (
		payload.sourceId !== requested.sourceId ||
		payload.sourceSha256 !== requested.sourceSha256 ||
		payload.a1Digest !== requested.a1Digest ||
		payload.indexId !== requested.indexId ||
		!SHA64.test(requested.sourceSha256) ||
		!SHA64.test(requested.a1Digest) ||
		requested.sourceId.length === 0 ||
		requested.indexId.length === 0
	) {
		throw new Error(
			"Frame selection response is not bound to the requested source",
		);
	}
	if (payload.keepIndexes.length === 0 || payload.keepRanges.length === 0) {
		throw new Error("Frame selection response is empty");
	}
	if (payload.keepIndexes.length !== payload.keepRanges.length) {
		throw new Error("Frame selection response reordered or expanded keeps");
	}
	const selected: { start: number; end: number }[] = [];
	let previous = -1;
	for (let offset = 0; offset < payload.keepIndexes.length; offset += 1) {
		const index = payload.keepIndexes[offset];
		const echoed = payload.keepRanges[offset];
		if (
			typeof index !== "number" ||
			!Number.isInteger(index) ||
			index <= previous ||
			index >= requested.keepRanges.length ||
			!echoed ||
			typeof echoed !== "object"
		) {
			throw new Error("Frame selection response reordered or expanded keeps");
		}
		const original = requested.keepRanges[index];
		const echoedRange = echoed as { start?: unknown; end?: unknown };
		if (
			!original ||
			echoedRange.start !== original.start ||
			echoedRange.end !== original.end
		) {
			throw new Error("Frame selection response reordered or expanded keeps");
		}
		selected.push({ start: original.start, end: original.end });
		previous = index;
	}
	return selected;
}

export type OriginClient = {
	prepareRevision(body: RevisionPrepareBody): Promise<RevisionPrepareResult>;
	selectFrames(body: FrameSelectionRequest): Promise<FrameSelectionResult>;
	fetchArtifact(input: {
		videoId: string;
		revisionId: string;
		name: string;
		method: "HEAD" | "GET";
	}): Promise<OriginArtifact>;
	requestDownload?(input: {
		videoId: string;
		revisionId: string;
		automatic?: boolean;
	}): Promise<{ status: number }>;
	writeCaptions?(input: {
		videoId: string;
		revisionId: string;
		intentId: string;
		sourceId: string;
		generation: number;
		publicationEpoch: number;
		policyEpoch: number;
		sourceSha256: string;
		captionsVtt: string;
	}): Promise<{ sha256: string }>;
};

export function originBaseUrl(): string {
	const raw = (
		process.env.CAP_INSTANT_FINISH_ORIGIN_INTERNAL_URL ??
		process.env.CAP_INSTANT_FINISH_ORIGIN_URL ??
		""
	).trim();
	if (!raw) {
		throw new Error("Instant finish origin is not configured");
	}
	return raw.replace(/\/$/, "");
}

function signedHeaders(method: string, path: string, body = ""): HeadersInit {
	return {
		"content-type": "application/json",
		[ORIGIN_SERVICE_HEADER]: signInternalServiceRequest({
			method,
			path,
			body,
		}),
	};
}

// undici's default headersTimeout is 300s. A cold A1 encode on a long source
// outlasts that and 500s the editor before Done can be shown.
const originDispatcher = new Agent({
	headersTimeout: 45 * 60 * 1000,
	bodyTimeout: 45 * 60 * 1000,
	connectTimeout: 30_000,
});

async function signedFetch(
	path: string,
	method: "GET" | "HEAD" | "POST",
	body = "",
	signal?: AbortSignal,
) {
	return originFetch(`${originBaseUrl()}${path}`, {
		method,
		headers: signedHeaders(method, path, body),
		body: method === "POST" ? body : undefined,
		dispatcher: originDispatcher,
		signal,
	});
}

export function httpOriginClient(signal?: AbortSignal): OriginClient {
	return {
		async prepareRevision(body) {
			const path = `/internal/revisions/${body.revisionId}/prepare`;
			const encoded = JSON.stringify(body);
			const response = await signedFetch(path, "POST", encoded, signal);
			if (!response.ok) {
				throw new Error(`Revision prepare failed with HTTP ${response.status}`);
			}
			const attestationBody = await response.text();
			const payload = JSON.parse(
				attestationBody,
			) as Partial<RevisionPrepareResult>;
			if (
				payload.playlistHasEndList !== true ||
				typeof payload.intentId !== "string" ||
				typeof payload.seg0DecodedFrames !== "number" ||
				typeof payload.initSha256 !== "string" ||
				typeof payload.seg0Sha256 !== "string" ||
				typeof payload.playlistDurationSeconds !== "number"
			) {
				throw new Error("Revision prepare did not return a decode attestation");
			}
			return {
				ready: payload.ready === true,
				intentId: payload.intentId,
				durationSeconds:
					payload.durationSeconds ?? payload.playlistDurationSeconds,
				durationTicks: payload.durationTicks,
				segmentCount: payload.segmentCount,
				seg0DecodedFrames: payload.seg0DecodedFrames,
				encoderHash: payload.encoderHash,
				segmentPlanVersion: payload.segmentPlanVersion,
				playlistHasEndList: true,
				decoded: payload.seg0DecodedFrames >= 1,
				decodedFrames: payload.decodedFrames ?? payload.seg0DecodedFrames,
				initSha256: payload.initSha256,
				seg0Sha256: payload.seg0Sha256,
				playlistDurationSeconds: payload.playlistDurationSeconds,
				attestationMac: response.headers.get(ORIGIN_ATTESTATION_HEADER) ?? "",
				attestationBody,
			};
		},
		async selectFrames(body) {
			const path = `/internal/sources/${body.videoId}/select-frames`;
			const encoded = JSON.stringify(body);
			const response = await signedFetch(path, "POST", encoded, signal);
			if (!response.ok) {
				throw new Error(`Frame selection failed with HTTP ${response.status}`);
			}
			const payload = (await response.json()) as unknown;
			const keepRanges = assertFrameSelection(body, payload);
			const parsed = payload as FrameSelectionResult;
			return {
				sourceId: parsed.sourceId,
				sourceSha256: parsed.sourceSha256,
				a1Digest: parsed.a1Digest,
				indexId: parsed.indexId,
				keepIndexes: parsed.keepIndexes,
				keepRanges,
			};
		},
		async fetchArtifact(input) {
			const path = `/internal/revisions/${input.revisionId}/artifact/${input.name}`;
			const response = await signedFetch(path, input.method);
			const body =
				input.method === "HEAD"
					? Buffer.alloc(0)
					: Buffer.from(await response.arrayBuffer());
			return {
				status: response.status,
				body,
				contentType: response.headers.get("content-type"),
			};
		},
		async requestDownload(input) {
			const path = `/internal/revisions/${input.revisionId}/download`;
			const encoded = JSON.stringify({ videoId: input.videoId, automatic: input.automatic === true });
			const response = await signedFetch(path, "POST", encoded);
			return { status: response.status };
		},
		async writeCaptions(input) {
			const path = `/internal/revisions/${input.revisionId}/captions`;
			const encoded = JSON.stringify(input);
			const response = await signedFetch(path, "POST", encoded, signal);
			if (!response.ok) {
				throw new Error(`Caption write failed with HTTP ${response.status}`);
			}
			const payload = (await response.json()) as { sha256?: string };
			if (!payload.sha256) throw new Error("Caption write omitted sha256");
			return { sha256: payload.sha256 };
		},
	};
}

export function originSourceId(sourceKey: string): string {
	return createHash("sha256").update(sourceKey).digest("hex").slice(0, 32);
}

export async function prepareSourceOnEditorOpen(input: {
	videoId: string;
	sourceKey: string;
	sourceId?: string;
}): Promise<SourcePrepareResult> {
	const sourceId = input.sourceId ?? originSourceId(input.sourceKey);
	const path = `/internal/sources/${input.videoId}/prepare`;
	const encoded = JSON.stringify({
		videoId: input.videoId,
		sourceId,
		sourceKey: input.sourceKey,
	} satisfies SourcePrepareBody);
	const response = await signedFetch(path, "POST", encoded);
	if (!response.ok) {
		throw new Error(`Source prepare failed with HTTP ${response.status}`);
	}
	const payload = (await response.json()) as Partial<SourcePrepareResult>;
	if (
		!payload.sourceKey ||
		!payload.sha256 ||
		!payload.codec ||
		!payload.timebase ||
		(payload.frameMode !== "vfr" && payload.frameMode !== "cfr") ||
		!payload.a1Digest ||
		!payload.indexId ||
		!payload.warmExpiresAt
	) {
		throw new Error(
			"Source prepare did not return an immutable source identity",
		);
	}
	return {
		sourceKey: payload.sourceKey,
		sha256: payload.sha256,
		codec: payload.codec,
		timebase: payload.timebase,
		frameMode: payload.frameMode,
		a1Digest: payload.a1Digest,
		indexId: payload.indexId,
		warmExpiresAt: payload.warmExpiresAt,
	};
}

export async function requestSourcePeaks(input: {
	videoId: string;
	sourceKey: string;
	sourceSha256: string;
	sourceDuration?: number;
}): Promise<{ status: number; body: unknown; responseBytes: number }> {
	const path = `/internal/sources/${input.videoId}/peaks`;
	const payload: {
		videoId: string;
		sourceId: string;
		sourceKey: string;
		sourceSha256: string;
		sourceDuration?: number;
	} = {
		videoId: input.videoId,
		sourceId: originSourceId(input.sourceKey),
		sourceKey: input.sourceKey,
		sourceSha256: input.sourceSha256,
	};
	if (input.sourceDuration !== undefined) {
		payload.sourceDuration = input.sourceDuration;
	}
	const encoded = JSON.stringify(payload);
	const response = await signedFetch(path, "POST", encoded);
	const text = await response.text();
	if (text.length > 8_000_000) {
		throw new Error("peaks response exceeds the size bound");
	}
	let body: unknown = null;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = null;
		}
	}
	return { status: response.status, body, responseBytes: text.length };
}

export function digestMatches(body: Buffer, expected: string): boolean {
	return sha256Hex(body) === expected;
}

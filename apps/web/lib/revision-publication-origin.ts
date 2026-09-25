import { createHash } from "node:crypto";
import type { VideoEditSpecV2 } from "@cap/database/types";
import {
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
};

export type OriginArtifact = {
	status: number;
	body: Buffer;
	contentType: string | null;
};

export type OriginClient = {
	prepareRevision(body: RevisionPrepareBody): Promise<RevisionPrepareResult>;
	fetchArtifact(input: {
		videoId: string;
		revisionId: string;
		name: string;
		method: "HEAD" | "GET";
	}): Promise<OriginArtifact>;
};

export function originBaseUrl(): string {
	const raw = process.env.CAP_INSTANT_FINISH_ORIGIN_URL?.trim() ?? "";
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

async function signedFetch(
	path: string,
	method: "GET" | "HEAD" | "POST",
	body = "",
) {
	return fetch(`${originBaseUrl()}${path}`, {
		method,
		headers: signedHeaders(method, path, body),
		body: method === "POST" ? body : undefined,
	});
}

export function httpOriginClient(): OriginClient {
	return {
		async prepareRevision(body) {
			const path = `/internal/revisions/${body.revisionId}/prepare`;
			const encoded = JSON.stringify(body);
			const response = await signedFetch(path, "POST", encoded);
			if (!response.ok) {
				throw new Error(`Revision prepare failed with HTTP ${response.status}`);
			}
			const payload = (await response.json()) as Partial<RevisionPrepareResult>;
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

export function digestMatches(body: Buffer, expected: string): boolean {
	return sha256Hex(body) === expected;
}

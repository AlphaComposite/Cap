import type { VideoEditSpecV2 } from "@cap/database/types";
import { sha256Hex } from "@/lib/revision-publication-metadata";

export const INTERNAL_TOKEN_HEADER = "x-cap-internal-token";

export type RevisionPrepareBody = {
	videoId: string;
	revisionId: string;
	intentId: string;
	sourceId: string;
	generation: number;
	durationSeconds: number;
	editSpec: VideoEditSpecV2;
	captionsVtt: string;
	chaptersJson: string;
	thumbnailPolicy: "source-zero" | "seg0-first-frame";
};

export type OriginArtifact = {
	status: number;
	body: Buffer;
	contentType: string | null;
};

export type OriginClient = {
	prepareRevision(body: RevisionPrepareBody): Promise<{
		decoded: boolean;
		decodedFrames: number;
		initSha256: string;
		seg0Sha256: string;
		playlistDurationSeconds: number;
	}>;
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

export function internalToken(): string {
	const token = process.env.CAP_INSTANT_FINISH_INTERNAL_TOKEN?.trim() ?? "";
	if (!token) {
		throw new Error("Instant finish internal authentication is not configured");
	}
	return token;
}

export function httpOriginClient(
	baseUrl = originBaseUrl(),
	token = internalToken(),
): OriginClient {
	return {
		async prepareRevision(body) {
			const response = await fetch(
				`${baseUrl}/internal/revisions/${body.revisionId}/prepare`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						[INTERNAL_TOKEN_HEADER]: token,
					},
					body: JSON.stringify(body),
				},
			);
			if (!response.ok) {
				throw new Error(`Revision prepare failed with HTTP ${response.status}`);
			}
			const payload = (await response.json()) as {
				decoded?: boolean;
				decodedFrames?: number;
				initSha256?: string;
				seg0Sha256?: string;
				playlistDurationSeconds?: number;
			};
			if (
				payload.decoded !== true ||
				typeof payload.initSha256 !== "string" ||
				typeof payload.seg0Sha256 !== "string" ||
				typeof payload.playlistDurationSeconds !== "number"
			) {
				throw new Error("Revision prepare did not return a decode attestation");
			}
			return {
				decoded: true,
				decodedFrames: payload.decodedFrames ?? 0,
				initSha256: payload.initSha256,
				seg0Sha256: payload.seg0Sha256,
				playlistDurationSeconds: payload.playlistDurationSeconds,
			};
		},
		async fetchArtifact(input) {
			const response = await fetch(
				`${baseUrl}/media/${input.videoId}/r/${input.revisionId}/${input.name}`,
				{
					method: input.method,
					headers: { [INTERNAL_TOKEN_HEADER]: token },
				},
			);
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

export async function prepareSourceOnEditorOpen(videoId: string): Promise<{
	sourceKey: string;
	sha256: string;
	codec: string;
	timebase: string;
	frameMode: "vfr" | "cfr";
	a1Digest: string;
	indexId: string;
	warmExpiresAt: string;
}> {
	const response = await fetch(
		`${originBaseUrl()}/internal/sources/${videoId}/prepare`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				[INTERNAL_TOKEN_HEADER]: internalToken(),
			},
			body: JSON.stringify({ videoId }),
		},
	);
	if (!response.ok) {
		throw new Error(`Source prepare failed with HTTP ${response.status}`);
	}
	const payload = (await response.json()) as {
		sourceKey?: string;
		sha256?: string;
		codec?: string;
		timebase?: string;
		frameMode?: string;
		a1Digest?: string;
		indexId?: string;
		warmExpiresAt?: string;
	};
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

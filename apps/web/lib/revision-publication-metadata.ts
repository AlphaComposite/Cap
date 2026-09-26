import { createHash } from "node:crypto";
import type { RevisionEncoderProfile } from "@cap/database/schema";
import type { VideoEditSpec, VideoEditSpecV2 } from "@cap/database/types";
import {
	EDIT_TRANSCRIPT_VERSION,
	type EditTranscript,
	remapEditTranscriptThroughSpec,
} from "@/lib/edit-transcript";
import {
	createIdentityEditSpec,
	getEditSpecOutputDuration,
	mapOutputChaptersToSource,
	normalizeVideoEditSpec,
	projectSourceChaptersToOutput,
	remapCurrentOutputTimeThroughEdit,
	type VideoChapter,
} from "@/lib/video-edits";

export const MAPPING_VERSION = 1;
export const SEGMENT_PLAN_VERSION = 1;
export const REFUSED_ENCODER_NAMESPACE = "eb3f663d";

export const ENCODER_PROFILE: RevisionEncoderProfile = {
	name: "a1-vfr",
	preset: "veryfast",
	crf: 18,
	bf: 0,
	gopSeconds: 1,
	fpsMode: "passthrough",
	audio: "aac-copy",
	encoderImpl: "a1-vfr-1",
	segmentPlanVersion: SEGMENT_PLAN_VERSION,
	mappingVersion: MAPPING_VERSION,
};

export const OUTBOX_JOBS = ["prewarm", "export", "purge", "readback"] as const;

export type SourceIdentity = {
	key: string;
	sha256: string;
	codec: string;
	timebase: string;
	frameMode: "vfr" | "cfr";
};

export type RevisionPublicationErrorBody = {
	success: false;
	status: number;
	error: string;
	generation: number | null;
	revisionId: string | null;
};

export class RevisionPublicationError extends Error {
	readonly status: number;
	readonly generation: number | null;
	readonly revisionId: string | null;

	constructor(
		status: number,
		message: string,
		generation: number | null = null,
		revisionId: string | null = null,
	) {
		super(message);
		this.name = "RevisionPublicationError";
		this.status = status;
		this.generation = generation;
		this.revisionId = revisionId;
	}
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			sorted[key] = sortJson(record[key]);
		}
		return sorted;
	}
	return value;
}

export function sha256Hex(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function sourceIdFromIdentity(identity: SourceIdentity): string {
	return canonicalJson({
		v: 1,
		key: identity.key,
		sha256: identity.sha256,
		codec: identity.codec,
		timebase: identity.timebase,
		frameMode: identity.frameMode,
	});
}

export function intentIdFor(input: {
	sourceId: string;
	spec: VideoEditSpecV2;
	mappingVersion: number;
	profile: RevisionEncoderProfile;
}): string {
	const blob = [
		`source:${input.sourceId}`,
		`spec:${canonicalJson(input.spec)}`,
		`mapping:${input.mappingVersion}`,
		`profile:${canonicalJson(input.profile)}`,
	].join("\0");
	return sha256Hex(blob);
}

export function encoderProfileHash(
	profile: RevisionEncoderProfile = ENCODER_PROFILE,
): string {
	return sha256Hex(canonicalJson(profile));
}

export function assertServableEncoderProfile(
	profile: RevisionEncoderProfile,
): void {
	if (
		profile.name !== ENCODER_PROFILE.name ||
		profile.segmentPlanVersion !== SEGMENT_PLAN_VERSION ||
		profile.mappingVersion !== MAPPING_VERSION ||
		profile.encoderImpl !== ENCODER_PROFILE.encoderImpl ||
		profile.bf !== 0 ||
		profile.fpsMode !== "passthrough"
	) {
		throw new RevisionPublicationError(
			409,
			"Encoder profile is not the current A1 segment plan",
		);
	}
	const hash = encoderProfileHash(profile);
	if (hash.startsWith(REFUSED_ENCODER_NAMESPACE)) {
		throw new RevisionPublicationError(409, "Refused legacy encoder namespace");
	}
}

export function requireV2Spec(spec: VideoEditSpec): VideoEditSpecV2 {
	const normalized = normalizeVideoEditSpec(spec);
	if (normalized.version !== 2) {
		throw new RevisionPublicationError(
			400,
			"Instant finish requires a committed V2 source-second spec",
		);
	}
	if (getEditSpecOutputDuration(normalized) <= 0) {
		throw new RevisionPublicationError(
			400,
			"Edit must keep at least one playable range",
		);
	}
	return normalized;
}

export function previousEditionSpec(input: {
	currentSpec: VideoEditSpec | null;
	rollbackSpec: VideoEditSpec | null;
	sourceDuration: number;
}): VideoEditSpec {
	if (input.currentSpec) return normalizeVideoEditSpec(input.currentSpec);
	if (input.rollbackSpec) return normalizeVideoEditSpec(input.rollbackSpec);
	return createIdentityEditSpec(input.sourceDuration);
}

export function deriveRevisionChapters(input: {
	storedChapters: readonly VideoChapter[];
	previousSpec: VideoEditSpec;
	nextSpec: VideoEditSpecV2;
}): VideoChapter[] {
	const sourceChapters = mapOutputChaptersToSource(
		[...input.storedChapters],
		input.previousSpec,
	);
	return projectSourceChaptersToOutput(sourceChapters, input.nextSpec);
}

export function deriveRevisionCaptions(input: {
	transcript: EditTranscript | null;
	nextSpec: VideoEditSpecV2;
}): { vtt: string; wordCount: number } {
	const duration = getEditSpecOutputDuration(input.nextSpec);
	if (!input.transcript) {
		return {
			vtt: captionsVtt([], duration),
			wordCount: 0,
		};
	}
	const remapped = remapEditTranscriptThroughSpec(
		input.transcript,
		input.nextSpec,
	);
	return {
		vtt: captionsVtt(remapped.words, duration),
		wordCount: remapped.words.length,
	};
}

function captionsVtt(
	words: EditTranscript["words"],
	durationSeconds: number,
): string {
	const lines = [
		"WEBVTT",
		"",
		`NOTE duration_seconds=${durationSeconds.toFixed(3)} mapping_version=${MAPPING_VERSION}`,
		"",
	];
	for (const word of words) {
		lines.push(
			`${vttClock(word.startMs)} --> ${vttClock(word.endMs)}`,
			word.text,
			"",
		);
	}
	return lines.join("\n");
}

function vttClock(ms: number): string {
	const clamped = Math.max(0, Math.round(ms));
	const hours = Math.floor(clamped / 3_600_000);
	const minutes = Math.floor((clamped % 3_600_000) / 60_000);
	const seconds = Math.floor((clamped % 60_000) / 1000);
	const millis = clamped % 1000;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function chaptersDocument(input: {
	chapters: readonly VideoChapter[];
	durationSeconds: number;
	sourceId: string;
}): string {
	return canonicalJson({
		chapters: input.chapters.map((chapter) => ({
			start: chapter.start,
			title: chapter.title,
		})),
		durationSeconds: input.durationSeconds,
		mappingVersion: MAPPING_VERSION,
		sourceId: input.sourceId,
	});
}

export function playlistDurationSeconds(playlist: string): number {
	if (!playlist.includes("#EXT-X-ENDLIST")) {
		throw new RevisionPublicationError(
			500,
			"Playlist is not a complete stable VOD playlist",
		);
	}
	const lines = playlist
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("#EXTINF:"));
	if (lines.length === 0) {
		throw new RevisionPublicationError(500, "Playlist has no EXTINF duration");
	}
	let total = 0;
	for (const line of lines) {
		const raw = line.slice("#EXTINF:".length).split(",")[0] ?? "";
		const value = Number(raw);
		if (!Number.isFinite(value) || value < 0) {
			throw new RevisionPublicationError(
				500,
				"Playlist EXTINF is not a duration",
			);
		}
		total += value;
	}
	return Math.round(total * 1000) / 1000;
}

export function remapCommentTimestamp(input: {
	timestamp: number | null;
	previousSpec: VideoEditSpec;
	nextSpec: VideoEditSpecV2;
}): number | null {
	return remapCurrentOutputTimeThroughEdit(
		input.timestamp,
		input.previousSpec,
		input.nextSpec,
	);
}

export function emptyTranscript(durationSeconds: number): EditTranscript {
	return {
		version: EDIT_TRANSCRIPT_VERSION,
		speechModelUsed: "unavailable",
		durationMs: Math.round(durationSeconds * 1000),
		languageCode: null,
		words: [],
	};
}

export function thumbnailBindsDuration(
	body: Buffer,
	durationSeconds: number,
): boolean {
	if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) return false;
	return body.includes(
		Buffer.from(`duration_seconds=${durationSeconds.toFixed(3)}`),
	);
}

export function isPendingThumbnail(body: Buffer): boolean {
	return (
		body.length === 4 &&
		body[0] === 0xff &&
		body[1] === 0xd8 &&
		body[2] === 0xff &&
		body[3] === 0xd9
	);
}

import { createHash } from "node:crypto";
import {
	decodePeaksObject,
	PEAKS_MAX_OBJECT_BYTES,
	validatePeaksAgainstDuration,
} from "@/lib/waveform-peaks";

const MAX_RESPONSE_BYTES = PEAKS_MAX_OBJECT_BYTES * 2 + 512;

export function classifyPeaksProducerStatus(input: {
	status: number;
	error?: string;
	accepted: boolean;
}): "write" | "retry" {
	if (input.status === 200 && input.accepted && input.error === undefined) {
		return "write";
	}
	return "retry";
}

export function acceptOriginPeaksPayload(input: {
	body: unknown;
	expectedSha256: string;
	sourceDuration: number | null;
	responseBytes?: number;
}):
	| { ok: true; bytes: Uint8Array; noAudio: boolean }
	| { ok: false; reason: string } {
	if ((input.responseBytes ?? 0) > MAX_RESPONSE_BYTES) {
		return { ok: false, reason: "response_size" };
	}
	if (!input.body || typeof input.body !== "object") {
		return { ok: false, reason: "shape" };
	}
	const record = input.body as Record<string, unknown>;
	if (record.audio !== "peaks" && record.audio !== "none") {
		return { ok: false, reason: "audio" };
	}
	if (record.sourceSha256 !== input.expectedSha256) {
		return { ok: false, reason: "sha" };
	}
	if (
		typeof record.peaks !== "string" ||
		typeof record.peaksSha256 !== "string"
	) {
		return { ok: false, reason: "shape" };
	}
	if (record.peaks.length > MAX_RESPONSE_BYTES) {
		return { ok: false, reason: "payload" };
	}
	const bytes = Buffer.from(record.peaks, "base64");
	if (bytes.byteLength > PEAKS_MAX_OBJECT_BYTES) {
		return { ok: false, reason: "length" };
	}
	const digest = createHash("sha256").update(bytes).digest("hex");
	if (digest !== record.peaksSha256) return { ok: false, reason: "peaks_sha" };
	const decoded = decodePeaksObject(bytes, input.expectedSha256);
	if (!decoded.ok) return decoded;
	if (record.audio === "none" && !decoded.noAudio) {
		return { ok: false, reason: "audio" };
	}
	if (record.audio === "peaks" && decoded.noAudio) {
		return { ok: false, reason: "audio" };
	}
	if (
		!validatePeaksAgainstDuration({
			pairCount: decoded.pairs.length,
			sourceDuration: decoded.noAudio ? 1 : (input.sourceDuration ?? 0),
			noAudio: decoded.noAudio,
		})
	) {
		return { ok: false, reason: "duration" };
	}
	return { ok: true, bytes, noAudio: decoded.noAudio };
}

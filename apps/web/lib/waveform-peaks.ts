export const PEAKS_MAGIC = "CAPW1";
export const PEAKS_VERSION = 1;
export const PEAKS_PAIRS_PER_SEC = 100;
export const PEAKS_SAMPLE_RATE = 48000;
export const PEAKS_SAMPLES_PER_PAIR = 480;
export const PEAKS_HEADER_BYTES = 64;
export const PEAKS_DB_FLOOR = -60;
export const PEAKS_CONTENT_TYPE = "application/vnd.cap.waveform-peaks";
export const PEAKS_CACHE_CONTROL = "private, no-store";
export const PEAKS_DURATION_SLACK_SECONDS = 0.05;
export const PEAKS_MAX_SOURCE_SECONDS = 14_400;
export const PEAKS_MAX_PAIR_COUNT =
	Math.ceil(PEAKS_MAX_SOURCE_SECONDS * PEAKS_PAIRS_PER_SEC) + 1;
export const PEAKS_MAX_OBJECT_BYTES =
	PEAKS_HEADER_BYTES + PEAKS_MAX_PAIR_COUNT * 2;

const VIDEO_ID = /^[A-Za-z0-9_-]{8,64}$/;
const SHA64 = /^[a-f0-9]{64}$/;

export type PeakPair = { min: number; max: number };

export type DecodedPeaks =
	| {
			ok: true;
			noAudio: boolean;
			sampleRate: number;
			samplesPerPair: number;
			pairsPerSec: number;
			sourceSha256: string;
			pairs: PeakPair[];
	  }
	| { ok: false; reason: string };

function roundHalfUp(value: number): number {
	return Math.floor(value + 0.5);
}

export function quantizePeakSample(sample: number): number {
	if (!Number.isFinite(sample) || sample === 0) return 0;
	const db = Math.min(
		0,
		Math.max(PEAKS_DB_FLOOR, 20 * Math.log10(Math.abs(sample))),
	);
	const mag = Math.min(
		127,
		Math.max(0, roundHalfUp(((db - PEAKS_DB_FLOOR) / -PEAKS_DB_FLOOR) * 127)),
	);
	if (mag === 0) return 0;
	return sample < 0 ? -mag : mag;
}

export function pairIndexForSourceTime(sourceTime: number): number {
	if (!Number.isFinite(sourceTime) || sourceTime < 0) return 0;
	return Math.floor(sourceTime * PEAKS_PAIRS_PER_SEC);
}

export function peaksObjectKey(
	videoId: string,
	sourceSha256: string,
): string | null {
	if (!VIDEO_ID.test(videoId) || !SHA64.test(sourceSha256)) return null;
	if (videoId.includes("/") || sourceSha256.includes("/")) return null;
	return `private/peaks/${videoId}/${sourceSha256}`;
}

export function encodePeaksObject(input: {
	sourceSha256: string;
	pairs: readonly PeakPair[];
	noAudio?: boolean;
}): Uint8Array {
	if (!SHA64.test(input.sourceSha256)) {
		throw new Error("peaks source sha is not 64 lowercase hex");
	}
	if (input.pairs.length > PEAKS_MAX_PAIR_COUNT) {
		throw new Error("peaks pair count exceeds the source bound");
	}
	const bytes = new Uint8Array(PEAKS_HEADER_BYTES + input.pairs.length * 2);
	bytes.set(Buffer.from(PEAKS_MAGIC, "ascii"));
	bytes[5] = PEAKS_VERSION;
	bytes[6] = input.noAudio ? 1 : 0;
	bytes[7] = PEAKS_PAIRS_PER_SEC;
	const view = new DataView(bytes.buffer);
	view.setUint32(8, PEAKS_SAMPLE_RATE, true);
	view.setUint16(12, PEAKS_SAMPLES_PER_PAIR, true);
	view.setUint32(14, input.noAudio ? 0 : input.pairs.length, true);
	bytes.set(Buffer.from(input.sourceSha256, "hex"), 18);
	if (!input.noAudio) {
		input.pairs.forEach((pair, index) => {
			const offset = PEAKS_HEADER_BYTES + index * 2;
			bytes[offset] = pair.min & 0xff;
			bytes[offset + 1] = pair.max & 0xff;
		});
	}
	return bytes;
}

function shaHex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

export function decodePeaksObject(
	bytes: Uint8Array,
	expectedSha256: string,
): DecodedPeaks {
	if (
		bytes.byteLength < PEAKS_HEADER_BYTES ||
		bytes.byteLength > PEAKS_MAX_OBJECT_BYTES
	) {
		return { ok: false, reason: "length" };
	}
	if (Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== PEAKS_MAGIC) {
		return { ok: false, reason: "magic" };
	}
	if (bytes[5] !== PEAKS_VERSION) return { ok: false, reason: "version" };
	const flags = bytes[6] ?? 0;
	if ((flags & ~0x01) !== 0) return { ok: false, reason: "flags" };
	if (bytes[7] !== PEAKS_PAIRS_PER_SEC)
		return { ok: false, reason: "pair_rate" };
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(8, true) !== PEAKS_SAMPLE_RATE) {
		return { ok: false, reason: "sample_rate" };
	}
	if (view.getUint16(12, true) !== PEAKS_SAMPLES_PER_PAIR) {
		return { ok: false, reason: "samples_per_pair" };
	}
	const pairCount = view.getUint32(14, true);
	if (pairCount > PEAKS_MAX_PAIR_COUNT)
		return { ok: false, reason: "pair_count" };
	const noAudio = (flags & 0x01) === 1;
	if (noAudio && pairCount !== 0) return { ok: false, reason: "pair_count" };
	const headerSha = shaHex(bytes.subarray(18, 50));
	if (headerSha !== expectedSha256 || !SHA64.test(expectedSha256)) {
		return { ok: false, reason: "sha" };
	}
	for (let index = 50; index < PEAKS_HEADER_BYTES; index += 1) {
		if (bytes[index] !== 0) return { ok: false, reason: "reserved" };
	}
	const payloadBytes = pairCount * 2;
	if (bytes.byteLength !== PEAKS_HEADER_BYTES + payloadBytes) {
		return { ok: false, reason: "length" };
	}
	const pairs: PeakPair[] = [];
	for (let index = 0; index < pairCount; index += 1) {
		const offset = PEAKS_HEADER_BYTES + index * 2;
		pairs.push({
			min: ((bytes[offset] ?? 0) << 24) >> 24,
			max: ((bytes[offset + 1] ?? 0) << 24) >> 24,
		});
	}
	return {
		ok: true,
		noAudio,
		sampleRate: PEAKS_SAMPLE_RATE,
		samplesPerPair: PEAKS_SAMPLES_PER_PAIR,
		pairsPerSec: PEAKS_PAIRS_PER_SEC,
		sourceSha256: headerSha,
		pairs,
	};
}

export function authoritativePeaksDuration(input: {
	videoDuration: number | null | undefined;
	sourceDuration: number | null | undefined;
}): number {
	if (
		typeof input.sourceDuration === "number" &&
		Number.isFinite(input.sourceDuration) &&
		input.sourceDuration > 0
	) {
		return input.sourceDuration;
	}
	if (
		typeof input.videoDuration === "number" &&
		Number.isFinite(input.videoDuration) &&
		input.videoDuration > 0
	) {
		return input.videoDuration;
	}
	return 0;
}

export function validatePeaksAgainstDuration(input: {
	pairCount: number;
	sourceDuration: number;
	noAudio?: boolean;
}): boolean {
	if (input.noAudio) return input.pairCount === 0;
	if (
		!Number.isFinite(input.sourceDuration) ||
		input.sourceDuration <= 0 ||
		input.sourceDuration > PEAKS_MAX_SOURCE_SECONDS ||
		!Number.isSafeInteger(input.pairCount) ||
		input.pairCount < 0 ||
		input.pairCount > PEAKS_MAX_PAIR_COUNT
	) {
		return false;
	}
	const expected = input.sourceDuration * PEAKS_PAIRS_PER_SEC;
	return (
		Math.abs(input.pairCount - expected) <=
		PEAKS_DURATION_SLACK_SECONDS * PEAKS_PAIRS_PER_SEC + 1
	);
}

export type WaveformColumn = { amplitude: number; kept: boolean };

export function waveformColumns(input: {
	pairs: readonly PeakPair[];
	windowStart: number;
	windowEnd: number;
	width: number;
	deleted: readonly { start: number; end: number }[];
}): WaveformColumn[] {
	const width = Math.max(0, Math.floor(input.width));
	const span = input.windowEnd - input.windowStart;
	if (width === 0 || !Number.isFinite(span) || span <= 0) return [];
	const columns: WaveformColumn[] = [];
	for (let column = 0; column < width; column += 1) {
		const start = input.windowStart + (column / width) * span;
		const end = input.windowStart + ((column + 1) / width) * span;
		const midpoint = (start + end) / 2;
		let peak = 0;
		const first = Math.max(0, Math.floor(start * PEAKS_PAIRS_PER_SEC));
		const last = Math.min(
			input.pairs.length - 1,
			Math.ceil(end * PEAKS_PAIRS_PER_SEC) - 1,
		);
		for (let index = first; index <= last; index += 1) {
			const pair = input.pairs[index];
			if (!pair) continue;
			peak = Math.max(
				peak,
				Math.min(127, Math.abs(pair.min)),
				Math.min(127, Math.abs(pair.max)),
			);
		}
		const kept = !input.deleted.some(
			(range) => midpoint >= range.start && midpoint < range.end,
		);
		columns.push({ amplitude: peak / 127, kept });
	}
	return columns;
}

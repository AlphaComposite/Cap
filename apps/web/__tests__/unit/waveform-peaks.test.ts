import { describe, expect, it } from "vitest";
import {
	decodePeaksObject,
	encodePeaksObject,
	PEAKS_HEADER_BYTES,
	PEAKS_MAX_PAIR_COUNT,
	PEAKS_PAIRS_PER_SEC,
	pairIndexForSourceTime,
	peaksObjectKey,
	quantizePeakSample,
	validatePeaksAgainstDuration,
	waveformColumns,
} from "@/lib/waveform-peaks";

const SHA = "ab".repeat(32);

describe("waveform peaks format", () => {
	it("round-trips a 64-byte header and signed pairs", () => {
		const bytes = encodePeaksObject({
			sourceSha256: SHA,
			pairs: [
				{ min: -12, max: 40 },
				{ min: 0, max: 0 },
			],
		});
		expect(bytes.byteLength).toBe(PEAKS_HEADER_BYTES + 4);
		expect(Buffer.from(bytes.subarray(0, 5)).toString("ascii")).toBe("CAPW1");
		const decoded = decodePeaksObject(bytes, SHA);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.noAudio).toBe(false);
		expect(decoded.sampleRate).toBe(48000);
		expect(decoded.samplesPerPair).toBe(480);
		expect(decoded.pairsPerSec).toBe(PEAKS_PAIRS_PER_SEC);
		expect(decoded.pairs).toEqual([
			{ min: -12, max: 40 },
			{ min: 0, max: 0 },
		]);
	});

	it("rejects a private/source key and an owner/video key", () => {
		expect(peaksObjectKey("video-ready-01", SHA)).toBe(
			`private/peaks/video-ready-01/${SHA}`,
		);
		expect(peaksObjectKey("owner/video", SHA)).toBeNull();
		expect(peaksObjectKey("short", SHA)).toBeNull();
		expect(
			peaksObjectKey(
				"video-ready-01",
				"private/source/video-ready-01/original",
			),
		).toBeNull();
	});

	it("rejects bad magic, version, rate, flags, reserved bytes, and a sha mismatch", () => {
		const bytes = encodePeaksObject({
			sourceSha256: SHA,
			pairs: [{ min: 1, max: 2 }],
		});
		const badMagic = new Uint8Array(bytes);
		badMagic[0] = 0x58;
		expect(decodePeaksObject(badMagic, SHA).ok).toBe(false);
		const badVersion = new Uint8Array(bytes);
		badVersion[5] = 2;
		expect(decodePeaksObject(badVersion, SHA).ok).toBe(false);
		const badRate = new Uint8Array(bytes);
		badRate[8] = 0;
		expect(decodePeaksObject(badRate, SHA).ok).toBe(false);
		const badFlags = new Uint8Array(bytes);
		badFlags[6] = 0x02;
		expect(decodePeaksObject(badFlags, SHA).ok).toBe(false);
		const reserved = new Uint8Array(bytes);
		reserved[50] = 1;
		expect(decodePeaksObject(reserved, SHA).ok).toBe(false);
		expect(decodePeaksObject(bytes, "cd".repeat(32)).ok).toBe(false);
	});

	it("refuses a giant pair count without allocating the payload", () => {
		const header = encodePeaksObject({
			sourceSha256: SHA,
			pairs: [],
			noAudio: false,
		});
		const forged = new Uint8Array(header);
		const view = new DataView(forged.buffer);
		view.setUint32(14, PEAKS_MAX_PAIR_COUNT + 1, true);
		const decoded = decodePeaksObject(forged, SHA);
		expect(decoded.ok).toBe(false);
		if (!decoded.ok) expect(decoded.reason).toBe("pair_count");
	});

	it("quantizes silence and non-finite samples to zero and keeps a quiet voice above the floor", () => {
		expect(quantizePeakSample(0)).toBe(0);
		expect(quantizePeakSample(Number.NaN)).toBe(0);
		expect(quantizePeakSample(Number.POSITIVE_INFINITY)).toBe(0);
		expect(quantizePeakSample(1)).toBe(127);
		expect(quantizePeakSample(-1)).toBe(-127);
		const quiet = 10 ** (-50 / 20);
		expect(quantizePeakSample(quiet)).toBeGreaterThan(0);
		expect(quantizePeakSample(-(10 ** (-70 / 20)))).toBe(0);
	});

	it("places a 10 ms spike in one 100 Hz pair", () => {
		expect(pairIndexForSourceTime(1.005)).toBe(100);
		expect(pairIndexForSourceTime(1.009)).toBe(100);
		expect(pairIndexForSourceTime(1.01)).toBe(101);
	});

	it("marks kept and deleted columns without zeroing removed amplitude", () => {
		const pairs = Array.from({ length: 100 }, () => ({ min: -20, max: 40 }));
		const columns = waveformColumns({
			pairs,
			windowStart: 0,
			windowEnd: 1,
			width: 10,
			deleted: [{ start: 0.4, end: 0.6 }],
		});
		expect(columns).toHaveLength(10);
		expect(columns[4]?.kept).toBe(false);
		expect(columns[5]?.kept).toBe(false);
		expect(columns[3]?.kept).toBe(true);
		expect(columns[6]?.kept).toBe(true);
		expect(columns[4]?.amplitude).toBeCloseTo(40 / 127);
		expect(columns[0]?.amplitude).toBeCloseTo(40 / 127);
	});

	it("draws silence as zero amplitude, not a floor", () => {
		const columns = waveformColumns({
			pairs: [
				{ min: 0, max: 0 },
				{ min: 0, max: 0 },
			],
			windowStart: 0,
			windowEnd: 0.02,
			width: 2,
			deleted: [],
		});
		expect(columns.every((column) => column.amplitude === 0)).toBe(true);
	});

	it("accepts pair counts within the existing 50 ms duration slack and rejects a giant shape", () => {
		expect(
			validatePeaksAgainstDuration({ pairCount: 100, sourceDuration: 1 }),
		).toBe(true);
		expect(
			validatePeaksAgainstDuration({ pairCount: 105, sourceDuration: 1 }),
		).toBe(true);
		expect(
			validatePeaksAgainstDuration({ pairCount: 200, sourceDuration: 1 }),
		).toBe(false);
		expect(
			validatePeaksAgainstDuration({
				pairCount: 0,
				sourceDuration: 12,
				noAudio: true,
			}),
		).toBe(true);
	});
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodePeaksObject } from "@/lib/waveform-peaks";
import {
	acceptOriginPeaksPayload,
	classifyPeaksProducerStatus,
} from "@/lib/waveform-peaks-accept";

const SHA = "ab".repeat(32);

describe("origin peaks admission", () => {
	it("does not store an audio_rejected result as no_audio", () => {
		expect(
			classifyPeaksProducerStatus({
				status: 409,
				error: "audio_rejected",
				accepted: false,
			}),
		).toBe("retry");
		expect(classifyPeaksProducerStatus({ status: 500, accepted: false })).toBe(
			"retry",
		);
	});

	it("accepts a duration-aligned payload and rejects a sha mismatch", () => {
		const bytes = encodePeaksObject({
			sourceSha256: SHA,
			pairs: [{ min: -4, max: 4 }],
		});
		const body = {
			audio: "peaks",
			peaks: Buffer.from(bytes).toString("base64"),
			peaksSha256: createHash("sha256").update(bytes).digest("hex"),
			sourceSha256: SHA,
		};
		expect(
			acceptOriginPeaksPayload({
				body,
				expectedSha256: SHA,
				sourceDuration: 0.01,
			}).ok,
		).toBe(true);
		expect(
			acceptOriginPeaksPayload({
				body: { ...body, sourceSha256: "cd".repeat(32) },
				expectedSha256: SHA,
				sourceDuration: 0.01,
			}),
		).toEqual({ ok: false, reason: "sha" });
	});
});

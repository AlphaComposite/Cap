import { describe, expect, it } from "vitest";
import {
	chooseTranscribeSourceKey,
	transcribeTempAudioKey,
} from "@/lib/transcribe-source";

describe("transcription temporary audio", () => {
	it("keeps flagged audio outside the public relocation inventory until consumed", () => {
		for (const filename of [
			"audio-temp.mp3",
			"audio-edit-transcript-v3-temp.mp3",
		]) {
			expect(
				transcribeTempAudioKey("owner", "vid", filename, {
					CAP_INSTANT_FINISH_OWNERS: "owner",
				}),
			).toBe(`private/source/vid/${filename}`);
			expect(transcribeTempAudioKey("owner", "vid", filename, {})).toBe(
				`owner/vid/${filename}`,
			);
		}
	});
});

describe("relocated transcription source", () => {
	it("chooses the private liveKey after the public candidates miss", () => {
		const liveKey = "private/source/vid/opaque";
		const chosen = chooseTranscribeSourceKey({
			userId: "owner",
			videoId: "vid",
			sourceKeyOverride: "owner/vid/source/original.mp4",
			rawFileKey: "owner/vid/raw-upload.mp4",
			liveKey,
			relocations: [
				{
					oldKey: "owner/vid/source/original.mp4",
					newKey: liveKey,
					state: "PURGED",
				},
			],
			present: (key) => key === liveKey,
		});
		expect(chosen).toBe(liveKey);
	});
});

import { describe, expect, it } from "vitest";
import { chooseTranscribeSourceKey } from "@/lib/transcribe-source";

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

import { describe, expect, it } from "vitest";
import { flaggedPlaylistGate } from "@/lib/playlist-flag-gate";

const env = {
	CAP_INSTANT_FINISH_OWNERS: "owner-flagged",
} as unknown as NodeJS.ProcessEnv;

describe("flagged playlist gate for an unedited source", () => {
	it("allows segments-master for an eligible flagged desktop recording and still blocks raw-preview", () => {
		expect(
			flaggedPlaylistGate({
				ownerId: "owner-flagged",
				videoType: "segments-master",
				sourceType: "desktopSegments",
				env,
				eligibleLegacy: true,
			}),
		).toBe("legacy");
		expect(
			flaggedPlaylistGate({
				ownerId: "owner-flagged",
				videoType: "raw-preview",
				sourceType: "webMP4",
				env,
				eligibleLegacy: true,
			}),
		).toBe("unavailable");
		expect(
			flaggedPlaylistGate({
				ownerId: "owner-flagged",
				videoType: "mp4",
				fileType: "transcription",
				sourceType: "webMP4",
				env,
				eligibleLegacy: true,
			}),
		).toBe("unavailable");
		expect(
			flaggedPlaylistGate({
				ownerId: "owner-flagged",
				videoType: "mp4",
				fileType: "enhanced-audio",
				sourceType: "webMP4",
				env,
				eligibleLegacy: true,
			}),
		).toBe("unavailable");
	});

	it("does not open a result.mp4 presign when an intent exists or the source is relocated", () => {
		for (const eligibleLegacy of [false, undefined]) {
			expect(
				flaggedPlaylistGate({
					ownerId: "owner-flagged",
					videoType: "mp4",
					sourceType: "webMP4",
					env,
					eligibleLegacy,
				}),
			).not.toBe("legacy");
		}
		expect(
			flaggedPlaylistGate({
				ownerId: "owner-flagged",
				videoType: "mp4",
				sourceType: "webMP4",
				env,
				eligibleLegacy: false,
			}),
		).toBe("revision");
	});

	it("leaves an unflagged raw-preview on the legacy gate", () => {
		expect(
			flaggedPlaylistGate({
				ownerId: "other-owner",
				videoType: "raw-preview",
				sourceType: "webMP4",
				env,
			}),
		).toBe("legacy");
	});
});

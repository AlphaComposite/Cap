import { describe, expect, it } from "vitest";
import {
	isPendingThumbnailMarker,
	isVerifiedJpeg,
	neutralPreviewJpeg,
	selectPreviewThumbnail,
	thumbnailSha256,
	thumbnailAtSeconds,
} from "@/lib/revision-thumbnail";

const marker = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const jpeg = neutralPreviewJpeg();

describe("edited thumbnail output time", () => {
	it("skips the tytbje source slivers to the first range lasting at least one second", () => {
		expect(thumbnailAtSeconds([
			{ start: 0, end: 0.15 },
			{ start: 285.67, end: 285.74 },
			{ start: 312.983, end: 313.053 },
			{ start: 533.476, end: 535.639 },
		])).toBeCloseTo(0.29, 8);
	});

	it("keeps an uncut video at output zero", () => {
		expect(thumbnailAtSeconds([{ start: 0, end: 600 }])).toBe(0);
	});

	it("falls back to zero when every range is shorter than one second", () => {
		expect(thumbnailAtSeconds([{ start: 5, end: 5.5 }, { start: 8, end: 8.9 }])).toBe(0);
		expect(thumbnailAtSeconds([])).toBe(0);
	});

	it("includes the one-second boundary and returns output, not source time", () => {
		expect(thumbnailAtSeconds([{ start: 5, end: 5.5 }, { start: 8, end: 9 }])).toBe(0.5);
	});
});

describe("revision thumbnail status", () => {
	it("keeps a failed thumbnail pending and serves a placeholder, not the marker", () => {
		expect(isPendingThumbnailMarker(marker)).toBe(true);
		expect(isVerifiedJpeg(marker)).toBe(false);
		const pending = selectPreviewThumbnail({
			currentState: "PENDING",
			currentBody: marker,
		});
		const failed = selectPreviewThumbnail({
			currentState: "FAILED",
			currentBody: marker,
		});
		expect(pending.kind).toBe("placeholder");
		expect(failed.kind).toBe("placeholder");
		expect(pending.body.equals(marker)).toBe(false);
		expect(isVerifiedJpeg(pending.body)).toBe(true);
	});

	it("serves a verified jpeg only after its sha matches the revision row", () => {
		const sha = thumbnailSha256(jpeg);
		expect(
			selectPreviewThumbnail({
				currentState: "READY",
				currentBody: jpeg,
				currentSha256: "f".repeat(64),
			}).kind,
		).toBe("placeholder");
		expect(
			selectPreviewThumbnail({
				currentState: "READY",
				currentBody: jpeg,
				currentSha256: sha,
			}),
		).toMatchObject({ kind: "current" });
		expect(
			selectPreviewThumbnail({
				currentState: "PENDING",
				previousState: "READY",
				previousBody: jpeg,
				previousSha256: sha,
			}).kind,
		).toBe("previous");
	});
});

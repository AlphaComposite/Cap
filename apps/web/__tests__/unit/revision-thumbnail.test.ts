import { describe, expect, it } from "vitest";
import {
	isPendingThumbnailMarker,
	isVerifiedJpeg,
	neutralPreviewJpeg,
	selectPreviewThumbnail,
	thumbnailSha256,
} from "@/lib/revision-thumbnail";

const marker = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const jpeg = neutralPreviewJpeg();

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

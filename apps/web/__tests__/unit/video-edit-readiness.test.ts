import { describe, expect, it } from "vitest";
import {
	deriveEditReadiness,
	publicationAdmitsPlayback,
} from "../../lib/video-edit-readiness";

const facts = {
	videoId: "video",
	identity: "current",
	eligible: true,
	isPro: true,
	playbackAdmission: true,
	videoState: "processed" as const,
	transcriptionStatus: "PROCESSING",
	transcriptRead: "unavailable" as const,
};

describe("independent editing readiness", () => {
	it.each([null, "PROCESSING", "ERROR", "SKIPPED", "NO_AUDIO", "unexpected"])(
		"keeps manual editing without word functions for %s",
		(status) => {
			const result = deriveEditReadiness({
				...facts,
				transcriptionStatus: status,
			});
			expect(result.manualEditing).toBe(true);
			expect(result.transcriptUsable).toBe(false);
			expect(result.playbackVerified).toBe(false);
		},
	);
	it("requires a usable sidecar rather than COMPLETE alone", () => {
		expect(
			deriveEditReadiness({ ...facts, transcriptionStatus: "COMPLETE" })
				.transcriptUsable,
		).toBe(false);
		expect(
			deriveEditReadiness({
				...facts,
				transcriptionStatus: "COMPLETE",
				transcriptRead: "ready",
			}).transcriptUsable,
		).toBe(true);
	});
	it("accepts no speech without inventing word candidates", () => {
		const result = deriveEditReadiness({
			...facts,
			transcriptionStatus: "COMPLETE",
			transcriptRead: "empty",
		});
		expect(result.transcriptLabel).toBe("No speech detected");
		expect(result.transcriptUsable).toBe(true);
		expect(result.manualEditing).toBe(true);
	});
	it("does not grant manual editing from processing100 or missing admission", () => {
		expect(
			deriveEditReadiness({
				...facts,
				playbackAdmission: false,
				videoState: "processing",
			}).manualEditing,
		).toBe(false);
	});
	it("observes enabled null handoff without inventing pending status", () => {
		const result = deriveEditReadiness({ ...facts, transcriptionStatus: null });
		expect(result.transcriptLabel).toBe("Transcript not started");
		expect(result.poll).toBe(true);
		expect(
			deriveEditReadiness({ ...facts, transcriptionStatus: "UNAVAILABLE" })
				.poll,
		).toBe(false);
	});
	it("preserves upgrade gating without mislabeling transcript failure", () => {
		expect(deriveEditReadiness({ ...facts, isPro: false }).manualEditing).toBe(
			false,
		);
	});
});

const publication = {
	videoId: "video",
	revisionVideoId: "video",
	currentRevisionId: "revision",
	revisionId: "revision",
	currentGeneration: 2,
	revisionGeneration: 2,
	publicationEpoch: 4,
	policyEpoch: 3,
	revisionState: "CURRENT",
	bucket: null,
	artifacts: [true, true, true],
};

describe("committed playback admission, not physical verification", () => {
	it("admits the current committed identity with every initial artifact", () => {
		expect(publicationAdmitsPlayback(publication)).toBe(true);
	});
	it.each([
		{ artifacts: [true, false, true] },
		{ currentGeneration: null },
		{ revisionGeneration: 1 },
		{ revisionVideoId: "other" },
		{ revisionState: "FAILED" },
		{ bucket: "private" },
		{ publicationEpoch: Number.NaN },
		{ currentRevisionId: "other" },
	])("fails closed for invalid evidence %s", (change) => {
		expect(publicationAdmitsPlayback({ ...publication, ...change })).toBe(
			false,
		);
	});
});

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
	it("does not equate playable with editor-openable", () => {
		const result = deriveEditReadiness({
			...facts,
			editorOpenable: false,
			sourcePrepare: "running",
		});
		expect(result.playbackAdmission).toBe(true);
		expect(result.manualEditing).toBe(false);
		expect(result.rows[4]).toMatchObject({
			label: "Preparing for editing",
			state: "running",
		});
		expect(result.poll).toBe(true);
	});
	it("shows preparing as done once the editor opens, even while caption work continues", () => {
		const result = deriveEditReadiness({
			...facts,
			editorOpenable: true,
			sourcePrepare: "running",
		});
		expect(result.editorOpenable).toBe(true);
		expect(result.rows[4]).toMatchObject({
			label: "Preparing for editing",
			state: "done",
		});
		expect(
			deriveEditReadiness({
				...facts,
				editorOpenable: true,
				sourcePrepare: "failed",
			}).rows[4].state,
		).toBe("failed");
	});
	it("derives the five completed steps and collapses only after completion", () => {
		const result = deriveEditReadiness({
			...facts,
			uploadPhase: "complete",
			transcriptionStatus: "COMPLETE",
			aiGenerationStatus: "COMPLETE",
			sourcePrepare: "done",
			editorOpenable: true,
		});
		expect(result.rows.map((row) => [row.label, row.state])).toEqual([
			["Uploaded", "done"],
			["Video processed", "done"],
			["Transcript", "done"],
			["Summary and chapters", "done"],
			["Preparing for editing", "done"],
		]);
		expect(result.allDone).toBe(true);
		expect(result.poll).toBe(false);
	});
	it("derives waiting and running states independently", () => {
		const uploading = deriveEditReadiness({
			...facts,
			uploadPhase: "uploading",
			videoState: "uploading",
			playbackAdmission: false,
			transcriptionStatus: null,
			aiGenerationStatus: "QUEUED",
			sourcePrepare: "queued",
			editorOpenable: false,
		});
		expect(uploading.rows.map((row) => row.state)).toEqual([
			"running",
			"waiting",
			"waiting",
			"waiting",
			"waiting",
		]);
		const processing = deriveEditReadiness({
			...facts,
			videoState: "processing",
			aiGenerationStatus: "PROCESSING",
			sourcePrepare: "running",
			editorOpenable: false,
		});
		expect(processing.rows.map((row) => row.state)).toEqual([
			"done",
			"running",
			"running",
			"running",
			"running",
		]);
	});
	it("keeps failure reasons and only supported retries", () => {
		const result = deriveEditReadiness({
			...facts,
			videoState: "failed",
			processingError: "Media processing failed",
			canRetryProcessing: true,
			transcriptionStatus: "ERROR",
			aiGenerationStatus: "ERROR",
			sourcePrepare: "failed",
			sourcePrepareError: "Source preparation exhausted",
			editorOpenable: false,
		});
		expect(
			result.rows.slice(1).map((row) => [row.state, row.reason, row.retry]),
		).toEqual([
			["failed", "Media processing failed", "processing"],
			["failed", "Transcription failed", "transcript"],
			["failed", "Summary and chapters generation failed", undefined],
			["failed", "Source preparation exhausted", undefined],
		]);
		expect(result.allDone).toBe(false);
		expect(result.poll).toBe(false);
		expect(
			deriveEditReadiness({
				...facts,
				transcriptionStatus: "COMPLETE",
				aiGenerationStatus: "ERROR",
			}).rows[3]?.retry,
		).toBe("ai");
	});
});

describe("upload failures", () => {
	it("reports upload failure without inventing a retry for a missing raw object", () => {
		const result = deriveEditReadiness({
			...facts,
			uploadPhase: "error",
			videoState: "failed",
			processingError: "Upload interrupted",
			canRetryProcessing: false,
		});
		expect(result.rows[0]).toMatchObject({
			state: "failed",
			reason: "Upload interrupted",
		});
		expect(result.rows[0]?.retry).toBeUndefined();
	});
	it("treats background source work after the editor can open as done", () => {
		const result = deriveEditReadiness({
			...facts,
			editorOpenable: true,
			sourcePrepare: "running",
			transcriptionStatus: "COMPLETE",
			aiGenerationStatus: "COMPLETE",
		});
		expect(result.rows[4]?.state).toBe("done");
		expect(result.allDone).toBe(true);
		expect(result.poll).toBe(false);
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

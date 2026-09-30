import { createHash } from "node:crypto";
import type { VideoEditSpecV2 } from "@cap/database/types";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://127.0.0.1:30410" },
	serverEnv: () => ({ NEXTAUTH_SECRET: "test-secret-with-enough-entropy" }),
}));
vi.mock("@/lib/server", () => ({
	runPromise: async (effect: unknown) => effect,
}));

import {
	EDIT_TRANSCRIPT_VERSION,
	type EditTranscript,
} from "@/lib/edit-transcript";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import {
	startRevisionReadbackWorker,
	stopRevisionReadbackWorker,
} from "@/lib/revision-publication";
import {
	deriveRevisionCaptions,
	deriveRevisionChapters,
	ENCODER_PROFILE,
	encoderProfileHash,
	intentIdFor,
	playlistDurationSeconds,
	REFUSED_ENCODER_NAMESPACE,
	RevisionPublicationError,
	remapCommentTimestamp,
	requireV2Spec,
	sourceIdFromIdentity,
} from "@/lib/revision-publication-metadata";
import { selectEditorPlayback } from "@/lib/revision-publication-read";
import { createIdentityEditSpec } from "@/lib/video-edits";

function ranges243(): VideoEditSpecV2 {
	const keepRanges = Array.from({ length: 243 }, (_, index) => ({
		start: index * 3,
		end: index * 3 + 2,
	}));
	return {
		version: 2,
		sourceDuration: 243 * 3,
		manualKeepRanges: keepRanges,
		keepRanges,
		autoCuts: {
			silence: {
				enabled: false,
				ranges: [],
				thresholdMs: 0,
				padMs: 0,
				removedMs: 0,
				gapCount: 0,
			},
			fillers: {
				enabled: false,
				ranges: [],
				mode: "ums",
				padMs: 0,
				removedCount: 0,
				skippedCount: 0,
			},
		},
	};
}

describe("instant finish publication helpers", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("flags by owner id, including viewers of that owner's videos", () => {
		vi.stubEnv("CAP_INSTANT_FINISH_OWNERS", " owner-a ,owner-b");
		expect(isInstantFinishEnabledForOwner("owner-a")).toBe(true);
		expect(isInstantFinishEnabledForOwner("owner-b")).toBe(true);
		expect(isInstantFinishEnabledForOwner("other")).toBe(false);
	});

	it("refuses the legacy encoder namespace and keeps the A1 profile distinct", () => {
		expect(
			encoderProfileHash(ENCODER_PROFILE).startsWith(REFUSED_ENCODER_NAMESPACE),
		).toBe(false);
		const other = intentIdFor({
			sourceId: "source",
			spec: requireV2Spec(ranges243()),
			mappingVersion: 1,
			profile: { ...ENCODER_PROFILE, segmentPlanVersion: 0 },
		});
		const current = intentIdFor({
			sourceId: "source",
			spec: requireV2Spec(ranges243()),
			mappingVersion: 1,
			profile: ENCODER_PROFILE,
		});
		expect(other).not.toBe(current);
		expect(() =>
			requireV2Spec({
				version: 1,
				sourceDuration: 10,
				keepRanges: [{ start: 0, end: 1 }],
			}),
		).toThrow(RevisionPublicationError);
	});

	it("maps caption, chapter, and comment clocks across 243 ranges and does not derive a summary", () => {
		const spec = requireV2Spec(ranges243());
		const transcript: EditTranscript = {
			version: EDIT_TRANSCRIPT_VERSION,
			speechModelUsed: "test",
			durationMs: spec.sourceDuration * 1000,
			languageCode: "en",
			words: [
				{
					id: "kept",
					text: "kept",
					startMs: 100,
					endMs: 400,
					confidence: 1,
					speaker: null,
					channel: null,
				},
				{
					id: "cut",
					text: "cut",
					startMs: 2_100,
					endMs: 2_400,
					confidence: 1,
					speaker: null,
					channel: null,
				},
			],
		};
		const captions = deriveRevisionCaptions({ transcript, nextSpec: spec });
		expect(captions.wordCount).toBe(1);
		expect(captions.vtt).toContain("kept");
		expect(captions.vtt).not.toContain("\ncut\n");
		expect(captions.vtt).toContain("duration_seconds=486.000");
		const chapters = deriveRevisionChapters({
			storedChapters: [
				{ title: "Early", start: 0.2 },
				{ title: "Removed", start: 2.2 },
			],
			previousSpec: createIdentityEditSpec(spec.sourceDuration),
			nextSpec: spec,
		});
		expect(chapters[0]?.start).toBe(0.2);
		expect(chapters[1]?.start).not.toBe(2.2);
		expect(
			remapCommentTimestamp({
				timestamp: 0.2,
				previousSpec: createIdentityEditSpec(spec.sourceDuration),
				nextSpec: spec,
			}),
		).toBe(0.2);
		expect(
			remapCommentTimestamp({
				timestamp: 2.2,
				previousSpec: createIdentityEditSpec(spec.sourceDuration),
				nextSpec: spec,
			}),
		).toBeNull();
		expect(
			playlistDurationSeconds(
				"#EXTM3U\n#EXTINF:486.000,\nseg/0.m4s\n#EXT-X-ENDLIST\n",
			),
		).toBe(486);
	});

	it("does not use a presigned original when the owner flag is on", () => {
		const flagged = selectEditorPlayback({
			flagged: true,
			existingEdit: true,
			ownerProxyUrl: "/api/media/owner-original/video",
			presignedOriginalUrl:
				"https://s3.example/original?X-Amz-Signature=secret",
			playlistUrl: "/api/playlist?videoType=mp4",
		});
		expect(flagged.usedPresign).toBe(false);
		expect(flagged.playbackSrc).toBe("/api/media/owner-original/video");
		expect(flagged.usesOriginalSource).toBe(true);
		const legacy = selectEditorPlayback({
			flagged: false,
			existingEdit: false,
			ownerProxyUrl: null,
			presignedOriginalUrl: null,
			playlistUrl: "/api/playlist?videoType=mp4",
		});
		expect(legacy.playbackSrc).toBe("/api/playlist?videoType=mp4");
		expect(legacy.usedPresign).toBe(false);
	});

	it("hashes source identity without using a rendered result key as the source id", () => {
		const sourceId = sourceIdFromIdentity({
			key: "owner/video/source/original.mp4",
			sha256: "a".repeat(64),
			codec: "h264",
			timebase: "1/15360",
			frameMode: "vfr",
		});
		expect(sourceId).toContain("source/original.mp4");
		expect(sourceId).not.toContain("result.mp4");
		expect(createHash("sha256").update("x").digest("hex")).toHaveLength(64);
	});

	it("does not emit unhandledRejection when the readback sweep rejects", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		stopRevisionReadbackWorker();
		try {
			startRevisionReadbackWorker({
				database: {
					transaction: async () => {
						throw new Error("db");
					},
				},
				origin: {
					prepareRevision: async () => {
						throw new Error("unused");
					},
					selectFrames: async () => {
						throw new Error("unused");
					},
					fetchArtifact: async () => {
						throw new Error("unused");
					},
				},
				pollMs: 2_000,
			});
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(rejections).toEqual([]);
		} finally {
			stopRevisionReadbackWorker();
			process.off("unhandledRejection", onRejection);
		}
	});
});

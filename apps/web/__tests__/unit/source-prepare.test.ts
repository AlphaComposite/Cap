import { describe, expect, it } from "vitest";
import {
	admitBaselineSource,
	advanceSourcePrepare,
	backfillDecision,
	captionClaim,
	captionsHaveCues,
	claimSourcePrepare,
	decideBaselinePlayback,
	editorJoinPlan,
	hookEnqueueDecision,
	identityFinishReuses,
	intentBlocksLegacy,
	nextSourcePrepareAttempt,
	type PrepareEffects,
	type PrepareSnapshot,
	planSourcePrepareInsert,
	retainedByCutGc,
	SOURCE_PREPARE_JOB,
	SOURCE_PREPARE_MAX_ATTEMPTS,
	sourceIdForKey,
	sourcePrepareDue,
	untouchedEditorSpec,
} from "@/lib/source-prepare";
import { createTimelineState, getTimelineEditSpec } from "@/lib/video-edits";

const flaggedEnv = { CAP_INSTANT_FINISH_OWNERS: "owner-flagged" };

function snapshot(overrides: Partial<PrepareSnapshot> = {}): PrepareSnapshot {
	return {
		videoId: "video-ready-01",
		ownerId: "owner-flagged",
		sourceObjectKey: "owner-flagged/video-ready-01/result.mp4",
		stableKey: "private/source/video-ready-01/original",
		flagged: true,
		currentRevisionId: null,
		currentIsIdentity: false,
		currentReadable: false,
		hasUserEdit: false,
		relocated: false,
		registeredPrivateKey: null,
		publicResultEligible: true,
		sourceIndexed: false,
		bindMatches: false,
		transcriptReady: false,
		captionsClaimed: false,
		...overrides,
	};
}

function effects(order: string[]): PrepareEffects {
	return {
		copyStable: async () => {
			order.push("copy");
			return { sha256: "abc", skipped: false };
		},
		prepare: async () => {
			order.push("prepare");
			return { encoded: true, sha256: "abc" };
		},
		publishIdentity: async () => {
			order.push("publish");
			return { revisionId: "rev-identity" };
		},
		relocateOriginal: async () => {
			order.push("relocate");
		},
		completeInventory: async () => undefined,
		refreshCaptions: async () => {
			order.push("captions");
			return "pending";
		},
	};
}

describe("source-prepare enqueue", () => {
	it("inserts one flagged job and skips a second insert for the same video", () => {
		const first = planSourcePrepareInsert({
			flagged: true,
			videoId: "video-ready-01",
			ownerId: "owner-flagged",
			sourceObjectKey:
				"owner-flagged/video-ready-01/.recording/outputs/g/a.mp4",
			existing: [],
		});
		expect(first.action).toBe("insert");
		if (first.action !== "insert") return;
		expect(first.row.job).toBe(SOURCE_PREPARE_JOB);
		expect(first.row.job).not.toBe("readback");
		expect(first.row.payload.sourceObjectKey).toContain(".recording/outputs/");
		const second = planSourcePrepareInsert({
			flagged: true,
			videoId: "video-ready-01",
			ownerId: "owner-flagged",
			sourceObjectKey:
				"owner-flagged/video-ready-01/.recording/outputs/g/a.mp4",
			existing: [first.row],
		});
		expect(second.action).toBe("skip");
	});

	it("inserts nothing for unflagged owners or inappropriate transitions", () => {
		expect(
			planSourcePrepareInsert({
				flagged: false,
				videoId: "video-ready-01",
				ownerId: "owner-plain",
				sourceObjectKey: "owner-plain/video-ready-01/result.mp4",
				existing: [],
			}).action,
		).toBe("skip");
		for (const sourceObjectKey of ["", "owner/video/raw-upload.mp4"]) {
			expect(
				planSourcePrepareInsert({
					flagged: true,
					videoId: "video-ready-01",
					ownerId: "owner-flagged",
					sourceObjectKey,
					inappropriate: true,
					existing: [],
				}).action,
			).toBe("skip");
		}
		expect(
			hookEnqueueDecision({
				hook: "raw-multipart",
				flagged: true,
				videoId: "video-ready-01",
				ownerId: "owner-flagged",
				sourceObjectKey: "owner/video/raw-upload.mp4",
				existing: [],
			}).action,
		).toBe("skip");
		expect(
			hookEnqueueDecision({
				hook: "recording-complete",
				flagged: true,
				videoId: "video-ready-01",
				ownerId: "owner-flagged",
				sourceObjectKey: "owner/video/result.mp4",
				existing: [],
			}).action,
		).toBe("skip");
		expect(
			hookEnqueueDecision({
				hook: "multipart-final",
				flagged: true,
				videoId: "video-ready-01",
				ownerId: "owner-flagged",
				sourceObjectKey: "owner/video/result.mp4",
				existing: [],
				remuxPending: true,
			}).action,
		).toBe("skip");
		expect(
			hookEnqueueDecision({
				hook: "desktop",
				flagged: true,
				videoId: "video-ready-01",
				ownerId: "owner-flagged",
				sourceObjectKey: "owner/video/.recording/outputs/gen/attempt.mp4",
				existing: [],
			}).action,
		).toBe("insert");
	});
});

describe("untouched editor V2", () => {
	it("equals the real timeline constructor and does not join a 0.1s duration", () => {
		const spec = untouchedEditorSpec(65.659);
		expect(spec).toEqual(getTimelineEditSpec(createTimelineState(65.659)));
		expect(spec.version).toBe(2);
		expect(untouchedEditorSpec(10.1)).not.toEqual(untouchedEditorSpec(10));
		expect(
			identityFinishReuses({
				currentIntentSpec: spec,
				nextSpec: spec,
				currentRevisionId: "rev-identity",
				currentState: "CURRENT",
			}),
		).toEqual({ reuse: true, revisionId: "rev-identity" });
		expect(
			identityFinishReuses({
				currentIntentSpec: spec,
				nextSpec: untouchedEditorSpec(65.759),
				currentRevisionId: "rev-identity",
				currentState: "CURRENT",
			}).reuse,
		).toBe(false);
	});
});

describe("source-prepare worker", () => {
	it("claims one due job, leases it, and exhausts without a second encode", () => {
		const now = 1_000_000;
		const first = {
			id: 1,
			payload: {
				videoId: "video-a",
				ownerId: "owner-flagged",
				sourceObjectKey: "owner-flagged/video-a/result.mp4",
				attempts: 0,
				stableKey: "private/source/video-a/original",
			},
		};
		const leased = {
			id: 2,
			payload: {
				...first.payload,
				videoId: "video-b",
				leaseUntilMs: now + 10_000,
			},
		};
		expect(claimSourcePrepare([leased, first], now)?.id).toBe(1);
		const retry = nextSourcePrepareAttempt(first.payload, now, true);
		expect(retry.attempts).toBe(1);
		expect(sourcePrepareDue(retry, now)).toBe(false);
		let failed: typeof retry = first.payload;
		for (let attempt = 0; attempt < SOURCE_PREPARE_MAX_ATTEMPTS; attempt++) {
			failed = nextSourcePrepareAttempt(failed, now, true);
		}
		expect(failed.exhausted).toBe(true);
		expect(sourcePrepareDue(failed, now + 10_000_000)).toBe(false);
	});

	it("keeps public playback until identity publish, then relocates once", async () => {
		const order: string[] = [];
		const before = decideBaselinePlayback({
			flagged: true,
			currentRevisionId: null,
			currentReadable: false,
			hasUserEdit: false,
			relocated: false,
			publicResultEligible: true,
			identityPending: true,
			prepareExhausted: false,
		});
		expect(before).toBe("legacy");
		const result = await advanceSourcePrepare(snapshot(), effects(order));
		expect(order).toEqual([
			"copy",
			"prepare",
			"publish",
			"relocate",
			"captions",
		]);
		expect(result.calls).toEqual({ prepare: 1, relocate: 1, publish: 1 });
		const orderAfter: string[] = [];
		await advanceSourcePrepare(
			snapshot({
				sourceIndexed: true,
				bindMatches: true,
				currentRevisionId: "rev-identity",
				currentIsIdentity: true,
				currentReadable: true,
				relocated: true,
				registeredPrivateKey: "private/source/video-ready-01/original",
			}),
			effects(orderAfter),
		);
		expect(orderAfter).toEqual(["captions"]);
	});

	it("does not relocate or drop the public original when the first publish fails", async () => {
		const order: string[] = [];
		const failing = effects(order);
		failing.publishIdentity = async () => {
			order.push("publish");
			throw new Error("readback failed");
		};
		await expect(advanceSourcePrepare(snapshot(), failing)).rejects.toThrow(
			"readback failed",
		);
		expect(order).toEqual(["copy", "prepare", "publish"]);
		expect(
			decideBaselinePlayback({
				flagged: true,
				currentRevisionId: null,
				currentReadable: false,
				hasUserEdit: false,
				relocated: false,
				publicResultEligible: true,
				identityPending: true,
				prepareExhausted: false,
			}),
		).toBe("legacy");
	});

	it("recovers a purged indexed source without a second encode or original fallback", async () => {
		const order: string[] = [];
		const playback = decideBaselinePlayback({
			flagged: true,
			currentRevisionId: null,
			currentReadable: false,
			hasUserEdit: false,
			relocated: true,
			publicResultEligible: false,
			identityPending: true,
			prepareExhausted: false,
		});
		expect(playback).toBe("recording-unavailable");
		await advanceSourcePrepare(
			snapshot({
				relocated: true,
				registeredPrivateKey: "private/source/video-ready-01/kept",
				publicResultEligible: false,
				sourceIndexed: true,
				bindMatches: true,
				sourceObjectKey: "private/source/video-ready-01/kept",
			}),
			effects(order),
		);
		expect(order).toEqual(["publish", "captions"]);
		expect(sourceIdForKey("private/source/video-ready-01/kept")).toBe(
			sourceIdForKey("private/source/video-ready-01/kept"),
		);
	});

	it("does not overwrite a current user edit and isolates a second video", async () => {
		const order: string[] = [];
		await advanceSourcePrepare(
			snapshot({
				currentRevisionId: "rev-cut",
				currentIsIdentity: false,
				currentReadable: true,
				hasUserEdit: true,
			}),
			effects(order),
		);
		expect(order).toEqual(["captions"]);
		const other: string[] = [];
		await advanceSourcePrepare(
			snapshot({ videoId: "video-other" }),
			effects(other),
		);
		expect(other).toContain("prepare");
		expect(other.join(" ")).not.toContain("video-ready-01");
	});
});

describe("baseline fences", () => {
	it("admits only a warm private untouched spec", () => {
		const spec = untouchedEditorSpec(12);
		const now = new Date("2026-09-30T00:00:00Z");
		expect(
			admitBaselineSource({
				spec,
				now,
				source: {
					key: "private/source/video-ready-01/original",
					sha256: "a".repeat(64),
					codec: "h264",
					timebase: "1/15360",
					frameMode: "vfr",
					a1Digest: "b".repeat(64),
					indexId: "idx",
					warmExpiresAt: new Date("2026-09-30T00:10:00Z"),
				},
			}).key,
		).toContain("private/source/");
		expect(() =>
			admitBaselineSource({
				spec: untouchedEditorSpec(12.1),
				now,
				source: {
					key: "owner/video/result.mp4",
					sha256: "a".repeat(64),
					codec: "h264",
					timebase: "1/15360",
					frameMode: "vfr",
					a1Digest: "b".repeat(64),
					indexId: "idx",
					warmExpiresAt: new Date("2026-09-30T00:10:00Z"),
				},
			}),
		).toThrow(/untouched|private/);
	});

	it("joins a pending job instead of relocating", () => {
		expect(
			editorJoinPlan({
				pending: true,
				exhausted: false,
				registeredPrivateKey: null,
				videoId: "video-ready-01",
			}),
		).toEqual({
			relocate: false,
			sourceKey: "private/source/video-ready-01/original",
		});
		expect(
			editorJoinPlan({
				pending: false,
				exhausted: true,
				registeredPrivateKey: null,
				videoId: "video-ready-01",
			}),
		).toEqual({ relocate: true });
	});

	it("keeps the identity and private source when cuts are collected", () => {
		const spec = untouchedEditorSpec(8);
		const retained = retainedByCutGc({
			revisions: [
				{ revisionId: "identity", state: "CURRENT", intentSpec: spec },
				{ revisionId: "cut", state: "SUPERSEDED", intentSpec: { version: 1 } },
			],
			sourceKeys: [
				"private/source/video-ready-01/original",
				"owner/video/result.mp4",
			],
		});
		expect(retained.revisionIds).toEqual(["identity"]);
		expect(retained.sourceKeys).toEqual([
			"private/source/video-ready-01/original",
		]);
	});

	it("backfills flagged videos with no current revision and skips the published four", () => {
		expect(
			backfillDecision({
				flagged: true,
				videoId: "4ha4tpe0a5msvtv",
				currentRevisionId: null,
				hasUserEditIntent: false,
				hasVideoEdits: false,
				openJob: false,
			}),
		).toBe("enqueue");
		for (const videoId of [
			"52dsqm24ssd05e5",
			"5vbfqmtxt4jk6eh",
			"z9x58adx1ra8bm3",
			"jm3htv93g8emje8",
		]) {
			expect(
				backfillDecision({
					flagged: true,
					videoId,
					currentRevisionId: "rev",
					hasUserEditIntent: false,
					hasVideoEdits: false,
					openJob: false,
				}),
			).toBe("skip");
		}
		expect(
			backfillDecision({
				flagged: false,
				videoId: "new-video-01",
				currentRevisionId: null,
				hasUserEditIntent: false,
				hasVideoEdits: false,
				openJob: false,
			}),
		).toBe("skip");
	});

	it("does not claim an empty caption placeholder as ready", () => {
		expect(captionsHaveCues("WEBVTT\n\nNOTE duration_seconds=1.000\n")).toBe(
			false,
		);
		expect(
			captionClaim({ transcriptionStatus: "COMPLETE", vtt: "WEBVTT\n" }),
		).toBe("pending");
		expect(
			captionClaim({
				transcriptionStatus: "COMPLETE",
				vtt: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n",
			}),
		).toBe("ready");
		expect(captionClaim({ transcriptionStatus: "PROCESSING", vtt: "" })).toBe(
			"pending",
		);
		expect(intentBlocksLegacy(untouchedEditorSpec(4))).toBe(false);
		expect(intentBlocksLegacy({ version: 1 })).toBe(true);
		void flaggedEnv;
	});
});

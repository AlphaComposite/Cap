import {
	editIntent,
	sourceObject,
	videoEdits,
	videos,
} from "@cap/database/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTimelineState, getTimelineEditSpec } from "@/lib/video-edits";

const rows = {
	intents: [] as Array<{ spec: unknown }>,
	edits: [] as Array<{ videoId: string }>,
	videos: [] as Array<{ metadata: unknown }>,
	sources: [] as Array<{ relocationState: string; liveKey: string }>,
};

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: unknown) => ({
				where: () => {
					const all =
						table === editIntent
							? rows.intents
							: table === videoEdits
								? rows.edits
								: table === videos
									? rows.videos
									: table === sourceObject
										? rows.sources
										: [];
					return Object.assign(Promise.resolve(all), {
						limit: async (count: number) => all.slice(0, count),
					});
				},
			}),
		}),
	}),
}));

describe("backend canonical identity", () => {
	beforeEach(() => {
		rows.intents = [];
		rows.edits = [];
		rows.videos = [{ metadata: null }];
		rows.sources = [
			{
				relocationState: "LIVE",
				liveKey: "owner-flagged/video-ready-01/result.mp4",
			},
		];
		process.env.CAP_INSTANT_FINISH_OWNERS = "owner-flagged";
	});

	it("keeps a staged identity eligible from a fresh backend import", async () => {
		const identity = getTimelineEditSpec(createTimelineState(20));
		rows.intents = [{ spec: identity }];
		const policy = await import("@cap/web-backend/src/flagged-unedited");
		const eligible = await policy.loadEligibleLegacy({
			videoId: "video-ready-01",
			ownerId: "owner-flagged",
		});
		expect(eligible).toBe(true);
	});

	it("blocks a later canonical cut even when an older identity exists", async () => {
		const identity = getTimelineEditSpec(createTimelineState(20));
		const cut = getTimelineEditSpec({
			...createTimelineState(20),
			deletedRanges: [{ start: 10, end: 20 }],
		});
		rows.intents = [{ spec: identity }, { spec: cut }];
		const policy = await import("@cap/web-backend/src/flagged-unedited");
		const eligible = await policy.loadEligibleLegacy({
			videoId: "video-ready-01",
			ownerId: "owner-flagged",
		});
		expect(eligible).toBe(false);
		expect(cut.keepRanges).toEqual([{ start: 0, end: 10 }]);
		expect(cut.manualKeepRanges).toEqual([{ start: 0, end: 10 }]);
	});

	it("rejects non-positive and malformed ranges without throwing or rejecting unknown fields", async () => {
		const { canonicalIdentitySpec, isCanonicalIdentitySpec } = await import(
			"@cap/web-backend/src/identity-edit-spec"
		);
		expect(isCanonicalIdentitySpec(canonicalIdentitySpec(0))).toBe(false);
		expect(isCanonicalIdentitySpec(canonicalIdentitySpec(Number.NaN))).toBe(
			false,
		);
		const positive = canonicalIdentitySpec(20);
		expect(isCanonicalIdentitySpec(positive)).toBe(true);
		expect(() =>
			isCanonicalIdentitySpec({ ...positive, keepRanges: "x" }),
		).not.toThrow();
		expect(isCanonicalIdentitySpec({ ...positive, keepRanges: "x" })).toBe(
			false,
		);
		expect(
			isCanonicalIdentitySpec({
				...positive,
				manualKeepRanges: [{ start: "0", end: 20 }],
			}),
		).toBe(false);
		expect(
			isCanonicalIdentitySpec({
				...positive,
				keepRanges: [{ start: Number.POSITIVE_INFINITY, end: 20 }],
			}),
		).toBe(false);
		expect(
			isCanonicalIdentitySpec({ ...positive, extra: { removed: [1, 2] } }),
		).toBe(true);
	});
});

import { describe, expect, it } from "vitest";
import {
	advanceSourcePrepare,
	enqueuePeaksOnly,
	type PrepareEffects,
	type PrepareSnapshot,
	planPeaksOnlyInsert,
	sweepSourcePrepare,
} from "@/lib/source-prepare";

const SHA = "ab".repeat(32);

function snapshot(overrides: Partial<PrepareSnapshot> = {}): PrepareSnapshot {
	return {
		videoId: "video-ready-01",
		ownerId: "owner-flagged",
		sourceObjectKey: "private/source/video-ready-01/original",
		stableKey: "private/source/video-ready-01/original",
		flagged: true,
		currentRevisionId: "rev-identity",
		currentIsIdentity: true,
		currentReadable: true,
		hasUserEdit: false,
		relocated: true,
		registeredPrivateKey: "private/source/video-ready-01/original",
		publicResultEligible: false,
		sourceIndexed: true,
		sourceWarm: true,
		bindMatches: true,
		transcriptReady: true,
		captionsClaimed: true,
		sourceSha256: SHA,
		peaksPresent: false,
		...overrides,
	};
}

function effects(order: string[]): PrepareEffects {
	return {
		copyStable: async () => {
			order.push("copy");
			return { sha256: SHA, skipped: true };
		},
		prepare: async () => {
			order.push("prepare");
			return { encoded: true, sha256: SHA };
		},
		publishIdentity: async () => {
			order.push("publish");
			return { revisionId: "rev-new" };
		},
		relocateOriginal: async () => {
			order.push("relocate");
		},
		completeInventory: async () => {
			order.push("inventory");
		},
		refreshCaptions: async () => {
			order.push("captions");
			return "ready";
		},
		ensurePeaks: async (input) => {
			order.push(`peaks:${input.videoId}`);
		},
	};
}

describe("peaks-only jobs", () => {
	it("inserts once, skips an open job, and reactivates a finished job", () => {
		const first = planPeaksOnlyInsert({
			videoId: "video-ready-01",
			ownerId: "owner-flagged",
			sourceObjectKey: "private/source/video-ready-01/original",
			sourceSha256: SHA,
			existing: [],
		});
		expect(first.action).toBe("insert");
		if (first.action !== "insert") return;
		expect(first.row.payload.peaksOnly).toBe(true);
		expect(first.row.job).toBe("source-prepare");
		const open = planPeaksOnlyInsert({
			videoId: "video-ready-01",
			ownerId: "owner-flagged",
			sourceObjectKey: "private/source/video-ready-01/original",
			sourceSha256: SHA,
			existing: [
				{
					id: 7,
					videoId: "video-ready-01",
					job: "source-prepare",
					payload: first.row.payload,
				},
			],
		});
		expect(open.action).toBe("skip");
		const again = planPeaksOnlyInsert({
			videoId: "video-ready-01",
			ownerId: "owner-flagged",
			sourceObjectKey: "private/source/video-ready-01/original",
			sourceSha256: SHA,
			existing: [
				{
					id: 7,
					videoId: "video-ready-01",
					job: "source-prepare",
					payload: { ...first.row.payload, finished: true },
				},
			],
		});
		expect(again.action).toBe("reactivate");
		if (again.action !== "reactivate") return;
		expect(again.id).toBe(7);
		expect(again.payload.finished).toBeUndefined();
		expect(again.payload.exhausted).toBeUndefined();
		expect(again.payload.peaksOnly).toBe(true);
	});

	it("does not let one video's open job block another", () => {
		const other = planPeaksOnlyInsert({
			videoId: "video-other-02",
			ownerId: "owner-flagged",
			sourceObjectKey: "private/source/video-other-02/original",
			sourceSha256: "cd".repeat(32),
			existing: [
				{
					id: 1,
					videoId: "video-ready-01",
					job: "source-prepare",
					payload: {
						videoId: "video-ready-01",
						ownerId: "owner-flagged",
						sourceObjectKey: "private/source/video-ready-01/original",
						attempts: 0,
						stableKey: "private/source/video-ready-01/original",
						peaksOnly: true,
					},
				},
			],
		});
		expect(other.action).toBe("insert");
	});

	it("claims a peaks-only job without publish, relocate, inventory, or captions", async () => {
		const order: string[] = [];
		const payload = {
			videoId: "video-ready-01",
			ownerId: "owner-flagged",
			sourceObjectKey: "private/source/video-ready-01/original",
			attempts: 0,
			stableKey: "private/source/video-ready-01/original",
			sha256: SHA,
			peaksOnly: true as const,
			phase: "peaks" as const,
		};
		const rows = [{ id: 4, payload }];
		const database = {
			select: () => ({
				from: () => ({
					where: () => {
						const query = Promise.resolve(rows) as Promise<typeof rows> & {
							orderBy: () => typeof query;
							limit: () => typeof query;
							for: () => Promise<typeof rows>;
						};
						query.orderBy = () => query;
						query.limit = () => query;
						query.for = async () => rows;
						return query;
					},
				}),
			}),
			update: () => ({
				set: (values: { payload?: typeof payload }) => ({
					where: async () => {
						if (rows[0] && values.payload) rows[0].payload = values.payload;
					},
				}),
			}),
			delete: () => ({
				where: async () => {
					rows.splice(0, rows.length);
				},
			}),
			transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
				fn(database),
		};
		const result = await sweepSourcePrepare(database as never, {
			now: new Date(1_000),
			effects: effects(order),
			load: async () => {
				order.push("load");
				return snapshot();
			},
			bindSource: async () => ({
				ownerId: "owner-flagged",
				liveKey: "private/source/video-ready-01/original",
				sha256: SHA,
			}),
		});
		expect(result.claimed).toBe(1);
		expect(order).toEqual(["peaks:video-ready-01"]);
		expect(rows).toHaveLength(0);
	});
});

describe("missing peaks on prepared currents", () => {
	it("enqueues peaks for a warm identity without publishing or relocating", async () => {
		const order: string[] = [];
		await advanceSourcePrepare(snapshot(), {
			...effects(order),
			readRegisteredSource: async () => ({
				ownerId: "owner-flagged",
				liveKey: "private/source/video-ready-01/original",
				sha256: SHA,
			}),
			schedulePeaks: async (input) => {
				order.push(`peaks:${input.videoId}`);
			},
		});
		expect(order).toContain("peaks:video-ready-01");
		expect(order).not.toContain("publish");
		expect(order).not.toContain("relocate");
		expect(order).not.toContain("prepare");
	});

	it("enqueues peaks for an edited current without publishing or relocating", async () => {
		const order: string[] = [];
		await advanceSourcePrepare(
			snapshot({
				hasUserEdit: true,
				currentIsIdentity: false,
				currentRevisionId: "rev-cut",
			}),
			{
				...effects(order),
				readRegisteredSource: async () => ({
					ownerId: "owner-flagged",
					liveKey: "private/source/video-ready-01/original",
					sha256: SHA,
				}),
				schedulePeaks: async (input) => {
					order.push(`peaks:${input.videoId}`);
				},
			},
		);
		expect(order).toContain("peaks:video-ready-01");
		expect(order).not.toContain("publish");
		expect(order).not.toContain("relocate");
		expect(order).not.toContain("prepare");
	});

	it("skips ensure when the peaks object is already present", async () => {
		const order: string[] = [];
		await advanceSourcePrepare(
			snapshot({ peaksPresent: true }),
			effects(order),
		);
		expect(order).not.toContain("peaks:video-ready-01");
	});
});

describe("peaks enqueue idempotence", () => {
	it("reactivates a completed row instead of inserting a second job", async () => {
		const updates: unknown[] = [];
		const inserts: unknown[] = [];
		const database = {
			select: () => ({
				from: () => ({
					where: async () => [
						{
							id: 9,
							payload: {
								videoId: "video-ready-01",
								ownerId: "owner-flagged",
								sourceObjectKey: "private/source/video-ready-01/original",
								attempts: 3,
								stableKey: "private/source/video-ready-01/original",
								sha256: SHA,
								peaksOnly: true,
								finished: true,
							},
						},
					],
				}),
			}),
			insert: () => ({
				values: async (row: unknown) => {
					inserts.push(row);
				},
			}),
			update: () => ({
				set: (values: unknown) => ({
					where: async () => {
						updates.push(values);
					},
				}),
			}),
			transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
				fn(database),
		};
		const result = await enqueuePeaksOnly(database as never, {
			videoId: "video-ready-01",
			ownerId: "owner-flagged",
			sourceObjectKey: "private/source/video-ready-01/original",
			sourceSha256: SHA,
		});
		expect(result).toBe("reactivated");
		expect(inserts).toHaveLength(0);
		expect(updates).toHaveLength(1);
	});
});

const LIVE_KEY = "private/source/video-ready-01/legacy-a1";
const NEXT_KEY = "private/source/video-ready-01/legacy-b2";
const NEXT_SHA = "cd".repeat(32);
const ORIGINAL_SUFFIX = "private/source/video-ready-01/original";

function peaksDatabase(
	rows: Array<{ id: number; payload: Record<string, unknown> }>,
) {
	return {
		select: () => ({
			from: () => ({
				where: () => {
					const query = Promise.resolve(rows) as Promise<typeof rows> & {
						orderBy: () => typeof query;
						limit: () => typeof query;
						for: () => Promise<typeof rows>;
					};
					query.orderBy = () => query;
					query.limit = () => query;
					query.for = async () => rows;
					return query;
				},
			}),
		}),
		update: () => ({
			set: (values: { payload?: Record<string, unknown> }) => ({
				where: async () => {
					if (rows[0] && values.payload) rows[0].payload = values.payload;
				},
			}),
		}),
		delete: () => ({
			where: async () => {
				rows.splice(0, rows.length);
			},
		}),
		insert: () => ({
			values: async () => undefined,
		}),
		transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
			fn(peaksDatabase(rows)),
	};
}

describe("registered peaks identity", () => {
	it("persists the registered private live key and sha, not an original suffix", () => {
		const planned = planPeaksOnlyInsert({
			videoId: "video-ready-01",
			ownerId: "owner-flagged",
			sourceObjectKey: LIVE_KEY,
			sourceSha256: SHA,
			existing: [],
		});
		expect(planned.action).toBe("insert");
		if (planned.action !== "insert") return;
		expect(planned.row.payload.sourceObjectKey).toBe(LIVE_KEY);
		expect(planned.row.payload.stableKey).toBe(LIVE_KEY);
		expect(planned.row.payload.stableKey).not.toBe(ORIGINAL_SUFFIX);
		expect(planned.row.payload.sha256).toBe(SHA);
		expect(planned.row.payload.ownerId).toBe("owner-flagged");
	});

	it("reactivates onto the current key, owner, and sha", () => {
		const again = planPeaksOnlyInsert({
			videoId: "video-ready-01",
			ownerId: "owner-new",
			sourceObjectKey: NEXT_KEY,
			sourceSha256: NEXT_SHA,
			existing: [
				{
					id: 3,
					videoId: "video-ready-01",
					job: "source-prepare",
					payload: {
						videoId: "video-ready-01",
						ownerId: "owner-old",
						sourceObjectKey: LIVE_KEY,
						stableKey: LIVE_KEY,
						sha256: SHA,
						attempts: 2,
						peaksOnly: true,
						finished: true,
					},
				},
			],
		});
		expect(again.action).toBe("reactivate");
		if (again.action !== "reactivate") return;
		expect(again.payload.sourceObjectKey).toBe(NEXT_KEY);
		expect(again.payload.stableKey).toBe(NEXT_KEY);
		expect(again.payload.ownerId).toBe("owner-new");
		expect(again.payload.sha256).toBe(NEXT_SHA);
		expect(again.payload.finished).toBeUndefined();
	});

	it("delivers the registered live key to the producer effect and denies a stale row", async () => {
		const seen: string[] = [];
		const order: string[] = [];
		const rows = [
			{
				id: 4,
				payload: {
					videoId: "video-ready-01",
					ownerId: "owner-flagged",
					sourceObjectKey: LIVE_KEY,
					stableKey: ORIGINAL_SUFFIX,
					sha256: SHA,
					attempts: 0,
					peaksOnly: true,
					phase: "peaks",
				},
			},
		];
		const database = peaksDatabase(rows);
		const accepted = await sweepSourcePrepare(
			database as never,
			{
				now: new Date(1_000),
				effects: {
					...effects(order),
					ensurePeaks: async (
						input: Parameters<NonNullable<PrepareEffects["ensurePeaks"]>>[0],
					) => {
						seen.push(input.sourceKey);
						seen.push(input.sourceSha256);
					},
				},
				load: async () => snapshot(),
				bindSource: async () => ({
					ownerId: "owner-flagged",
					liveKey: LIVE_KEY,
					sha256: SHA,
				}),
			} as never,
		);
		expect(accepted.claimed).toBe(1);
		expect(seen).toEqual([LIVE_KEY, SHA]);
		expect(order).not.toContain("publish");
		expect(order).not.toContain("relocate");
		expect(rows).toHaveLength(0);

		const stale: Array<{
			id: number;
			payload: {
				videoId: string;
				ownerId: string;
				sourceObjectKey: string;
				stableKey: string;
				sha256: string;
				attempts: number;
				peaksOnly: boolean;
				notBeforeMs?: number;
			};
		}> = [
			{
				id: 8,
				payload: {
					videoId: "video-ready-01",
					ownerId: "owner-flagged",
					sourceObjectKey: LIVE_KEY,
					stableKey: ORIGINAL_SUFFIX,
					sha256: SHA,
					attempts: 0,
					peaksOnly: true,
				},
			},
		];
		const deniedPeaks: string[] = [];
		await sweepSourcePrepare(
			peaksDatabase(stale) as never,
			{
				now: new Date(2_000),
				effects: {
					...effects(order),
					ensurePeaks: async () => {
						deniedPeaks.push("wrote");
					},
				},
				load: async () => snapshot(),
				bindSource: async () => ({
					ownerId: "owner-other",
					liveKey: NEXT_KEY,
					sha256: NEXT_SHA,
				}),
			} as never,
		);
		expect(deniedPeaks).toEqual([]);
		expect(stale).toHaveLength(1);
		expect(stale[0]?.payload.attempts).toBe(1);
		expect(stale[0]?.payload.notBeforeMs).toBeGreaterThan(2_000);
		expect(order).not.toContain("publish");
	});
});

describe("optional peaks do not block core preparation", () => {
	const registered = {
		ownerId: "owner-flagged",
		liveKey: "private/source/video-cold-01/legacy-a1",
		sha256: "",
	};

	function memoryOutbox(
		rows: Array<{
			payload?: {
				sha256?: string;
				sourceObjectKey?: string;
				peaksOnly?: boolean;
			};
		}>,
	) {
		const tx = {
			select: () => ({
				from: () => ({
					where: async () => rows,
				}),
			}),
			insert: () => ({
				values: async (row: (typeof rows)[number]) => {
					rows.push(row);
				},
			}),
			update: () => ({
				set: () => ({
					where: async () => undefined,
				}),
			}),
		};
		return Object.assign(tx, {
			transaction: async (fn: (locked: typeof tx) => Promise<unknown>) =>
				fn(tx),
		});
	}

	it("enqueues the sha registered by cold prepare and still publishes", async () => {
		const order: string[] = [];
		const rows: Array<{
			payload?: {
				sha256?: string;
				sourceObjectKey?: string;
				peaksOnly?: boolean;
			};
		}> = [];
		const decoded: string[] = [];
		await advanceSourcePrepare(
			snapshot({
				videoId: "video-cold-01",
				sourceObjectKey: "owner/video-cold-01/result.mp4",
				stableKey: "private/source/video-cold-01/original",
				sourceSha256: undefined,
				peaksPresent: undefined,
				currentRevisionId: null,
				currentIsIdentity: false,
				currentReadable: false,
				relocated: false,
				registeredPrivateKey: null,
				sourceIndexed: false,
				sourceWarm: false,
				bindMatches: false,
				captionsClaimed: false,
				publicResultEligible: true,
			}),
			{
				...effects(order),
				prepare: async () => {
					order.push("prepare");
					registered.sha256 = NEXT_SHA;
					decoded.push("cold-decode");
					return { encoded: true, sha256: NEXT_SHA };
				},
				ensurePeaks: async () => {
					order.push("peaks-inline");
					decoded.push("peaks-decode");
					throw new Error("peaks transport failed");
				},
				readRegisteredSource: async () => ({ ...registered }),
				schedulePeaks: async (input) => {
					order.push("enqueue");
					await enqueuePeaksOnly(memoryOutbox(rows) as never, input);
				},
			},
		);
		expect(order).toEqual([
			"copy",
			"prepare",
			"publish",
			"relocate",
			"captions",
			"inventory",
			"enqueue",
		]);
		expect(order).not.toContain("peaks-inline");
		expect(decoded).toEqual(["cold-decode"]);
		expect(rows[0]?.payload?.sha256).toBe(NEXT_SHA);
		expect(rows[0]?.payload?.sourceObjectKey).toBe(registered.liveKey);
		expect(rows[0]?.payload?.peaksOnly).toBe(true);
	});

	it("finishes a warm identity when the peaks effect throws", async () => {
		const order: string[] = [];
		await advanceSourcePrepare(
			snapshot({ captionsClaimed: false, relocated: true }),
			{
				...effects(order),
				ensurePeaks: async () => {
					order.push("peaks-inline");
					throw new Error("peaks transport failed");
				},
				readRegisteredSource: async () => ({
					ownerId: "owner-flagged",
					liveKey: "private/source/video-ready-01/original",
					sha256: SHA,
				}),
				schedulePeaks: async () => {
					order.push("enqueue");
				},
			},
		);
		expect(order).toContain("captions");
		expect(order).toContain("inventory");
		expect(order).toContain("enqueue");
		expect(order).not.toContain("peaks-inline");
		expect(order).not.toContain("publish");
		expect(order).not.toContain("relocate");
		expect(order).not.toContain("prepare");
	});

	it("finishes an edited current when the peaks effect throws", async () => {
		const order: string[] = [];
		await advanceSourcePrepare(
			snapshot({
				hasUserEdit: true,
				currentIsIdentity: false,
				currentRevisionId: "rev-cut",
				captionsClaimed: false,
				relocated: true,
			}),
			{
				...effects(order),
				ensurePeaks: async () => {
					throw new Error("reducer failed");
				},
				readRegisteredSource: async () => ({
					ownerId: "owner-flagged",
					liveKey: LIVE_KEY,
					sha256: SHA,
				}),
				schedulePeaks: async (input) => {
					order.push(`enqueue:${input.sourceObjectKey}:${input.sourceSha256}`);
				},
			},
		);
		expect(order).toContain("captions");
		expect(order).toContain("inventory");
		expect(order).toContain(`enqueue:${LIVE_KEY}:${SHA}`);
		expect(order).not.toContain("publish");
		expect(order).not.toContain("relocate");
	});
});

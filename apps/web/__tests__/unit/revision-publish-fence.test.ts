import { editRevision, videoPublication, videos } from "@cap/database/schema";
import type { VideoEditSpecV2 } from "@cap/database/types";
import { defaultAutoCuts } from "@cap/web-backend/src/identity-edit-spec";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://localhost:3000" },
	serverEnv: () => ({ NEXTAUTH_SECRET: "test-secret-with-enough-entropy" }),
}));
const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	update: vi.fn(),
	lock: vi.fn(),
}));
vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "owner" }),
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("@/lib/instant-finish-flag", () => ({
	isInstantFinishEnabledForOwner: () => true,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
	allocateRevision,
	flipCurrent,
	recordServerDraft,
} from "../../lib/revision-publication";
import {
	parseRevisionRouteBody,
	publishOwnerRevision,
} from "../../lib/revision-publish";

let publication: {
	draftSession: string;
	latestDraftVersion: number;
	generation: number;
	currentRevisionId: string;
};
const spec: VideoEditSpecV2 = {
	version: 2,
	sourceDuration: 10,
	keepRanges: [{ start: 1, end: 9 }],
	manualKeepRanges: [{ start: 1, end: 9 }],
	autoCuts: defaultAutoCuts(),
};
const input = {
	videoId: "video" as never,
	editSpec: spec,
	expectedEditSpec: spec,
	baseGeneration: 4,
	draftVersion: 7,
	draftSession: "A",
};
const database = {
	transaction: async <T>(run: (tx: typeof transaction) => Promise<T>) =>
		run(transaction),
};
const transaction = {
	select: () => ({
		from: (table: unknown) => ({
			where: () => {
				const rows =
					table === videoPublication
						? [{ ...publication }]
						: table === editRevision
							? [{ revisionId: "current", generation: 4 }]
							: [
									{
										id: "video",
										ownerId: "owner",
										source: { type: "webMP4" },
										bucket: null,
										storageIntegrationId: null,
									},
								];
				return Object.assign(Promise.resolve(rows), {
					for: async (mode: string) => {
						mocks.lock(table, mode);
						return rows;
					},
				});
			},
		}),
	}),
	insert: () => ({
		values: () => ({ onDuplicateKeyUpdate: async () => undefined }),
	}),
	update: (table: unknown) => ({
		set: (values: Partial<typeof publication>) => ({
			where: async () => {
				mocks.update(table, values);
				Object.assign(publication, values);
			},
		}),
	}),
};
beforeEach(() => {
	publication = {
		draftSession: "A",
		latestDraftVersion: 6,
		generation: 4,
		currentRevisionId: "current",
	};
	mocks.db.mockReturnValue({ ...database, ...transaction });
});
const conflict = {
	status: 409,
	message:
		"This video was edited in another session. Reload before publishing.",
};

describe("atomic Done retry session fence", () => {
	it.each([7, 8])(
		"rejects refresh A, draft B at version %s, then A retry without publishing",
		async (draftVersion) => {
			const refreshed = { ...publication };
			await recordServerDraft(database, {
				...input,
				draftSession: "B",
				draftVersion,
			});
			mocks.update.mockClear();
			mocks.lock.mockClear();
			await expect(
				publishOwnerRevision(
					{ ...input, expectedDraftSession: refreshed.draftSession },
					new Headers(),
				),
			).rejects.toMatchObject(conflict);
			expect(mocks.lock.mock.calls).toEqual([
				[videos, "update"],
				[videoPublication, "update"],
			]);
			expect(mocks.update).not.toHaveBeenCalled();
			expect(publication).toEqual({
				...refreshed,
				draftSession: "B",
				latestDraftVersion: draftVersion,
			});
		},
	);

	it("fences an empty refreshed session against a newly recorded competing draft", async () => {
		publication.draftSession = "";
		const expectedDraftSession = publication.draftSession;
		await recordServerDraft(database, { ...input, draftSession: "B" });
		mocks.update.mockClear();
		await expect(
			publishOwnerRevision({ ...input, expectedDraftSession }, new Headers()),
		).rejects.toMatchObject(conflict);
		expect(mocks.update).not.toHaveBeenCalled();
		expect(publication.draftSession).toBe("B");
	});

	it.each(["A", ""])(
		"allows the unchanged %j session under lock",
		async (draftSession) => {
			publication.draftSession = draftSession;
			await expect(
				recordServerDraft(database, {
					...input,
					expectedDraftSession: draftSession,
				}),
			).resolves.toMatchObject({ draftSession: "A", draftVersion: 7 });
		},
	);

	it("keeps non-retry draft takeover unchanged", async () => {
		await expect(
			recordServerDraft(database, { ...input, draftSession: "B" }),
		).resolves.toMatchObject({ draftSession: "B", draftVersion: 7 });
	});

	it("rechecks the fence at allocation after a competing draft replaces the recorded retry", async () => {
		await recordServerDraft(database, { ...input, expectedDraftSession: "A" });
		await recordServerDraft(database, {
			...input,
			draftSession: "B",
			draftVersion: 8,
		});
		mocks.update.mockClear();
		await expect(
			allocateRevision(
				transaction as unknown as Parameters<typeof allocateRevision>[0],
				{ ...input, expectedDraftSession: "A" },
				spec,
				new Date(),
				() => "new",
			),
		).rejects.toMatchObject(conflict);
		expect(mocks.update).not.toHaveBeenCalled();
		expect(publication.currentRevisionId).toBe("current");
	});

	it("rechecks the fence before flipping CURRENT", async () => {
		await recordServerDraft(database, { ...input, draftSession: "B" });
		mocks.update.mockClear();
		await expect(
			flipCurrent(
				transaction as unknown as Parameters<typeof flipCurrent>[0],
				{ ...input, expectedDraftSession: "A" },
				spec,
				{ revisionId: "new" } as Parameters<typeof flipCurrent>[3],
				{} as Parameters<typeof flipCurrent>[4],
				new Date(),
			),
		).rejects.toMatchObject(conflict);
		expect(mocks.update).not.toHaveBeenCalled();
		expect(publication.currentRevisionId).toBe("current");
	});

	it.each(["A", "", undefined])(
		"preserves the optional route fence %j",
		(expectedDraftSession) => {
			expect(
				parseRevisionRouteBody({ ...input, expectedDraftSession })
					?.expectedDraftSession,
			).toBe(expectedDraftSession);
		},
	);
	it.each([null, 7, {}])(
		"rejects an invalid route fence %j",
		(expectedDraftSession) => {
			expect(
				parseRevisionRouteBody({ ...input, expectedDraftSession }),
			).toBeNull();
		},
	);
});

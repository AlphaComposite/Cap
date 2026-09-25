import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://127.0.0.1:3000" },
	serverEnv: () => ({ NEXTAUTH_SECRET: "test-secret-with-enough-entropy" }),
}));
vi.mock("@cap/database", () => ({ db: () => ({}) }));

import {
	ACL_LOSS_PATHS,
	type AclExecutor,
	applyLossOfAccess,
	refuseFlaggedOwnershipTransfer,
	sqlTextForTest,
} from "@/lib/acl-policy-epoch";
import { classifyLiveGrant } from "@/lib/revision-media-grant";
import {
	signRevisionMediaGrant,
	verifyRevisionMediaGrant,
} from "@/lib/revision-media-token";

const env = {
	REVISION_MEDIA_GRANT_KEYS: "v1:current-secret-current-secret-32b",
	CAP_INSTANT_FINISH_OWNERS: "owner-flagged",
} as unknown as NodeJS.ProcessEnv;

const now = 1_700_000_000;

function executorFor(videoIds: string[]) {
	const epochs = new Map(videoIds.map((id) => [id, 4]));
	const sql: string[] = [];
	const executor: AclExecutor = {
		async execute(query) {
			const text = sqlTextForTest(query);
			sql.push(text);
			if (text.includes("FROM videos")) {
				return [{ ownerId: "owner-flagged" }];
			}
			if (
				text.includes("FROM space_videos") ||
				text.includes("FROM shared_videos")
			) {
				return videoIds.map((videoId) => ({ videoId }));
			}
			if (text.includes("policyEpoch = policyEpoch + 1")) {
				for (const id of videoIds) epochs.set(id, (epochs.get(id) ?? 0) + 1);
				return [{ affectedRows: videoIds.length }];
			}
			return [];
		},
	};
	return { executor, epochs, sql };
}

describe("F2 ACL revocation bumps policy epoch before the next grant use", () => {
	process.env.CAP_INSTANT_FINISH_OWNERS = "owner-flagged";
	process.env.REVISION_MEDIA_GRANT_KEYS =
		"v1:current-secret-current-secret-32b";

	it.each(ACL_LOSS_PATHS)(
		"%s classifies a previously verified grant as 410",
		async (path) => {
			const videoId = "video1";
			const { executor, epochs } = executorFor([videoId]);
			const token = signRevisionMediaGrant(
				{
					videoId,
					revisionId: "rev1",
					publicationEpoch: 3,
					policyEpoch: 4,
					now,
				},
				env,
			);
			const verified = verifyRevisionMediaGrant(token, { now, env });
			expect(verified.ok).toBe(true);

			await applyLossOfAccess(path, executor, {
				organizationId: "org1",
				spaceId: "space1",
				videoIds: [videoId],
			});

			const classified = classifyLiveGrant(
				token,
				{
					videoId,
					revisionId: "rev1",
					publicationEpoch: 3,
					policyEpoch: epochs.get(videoId) ?? 4,
					currentRevisionId: "rev1",
					deleted: false,
					privateOrUnauthorized: false,
				},
				{ now, env },
			);
			expect(classified).toEqual({
				ok: false,
				denial: "stale_policy",
				status: 410,
			});
		},
	);

	it("refuses ownership transfer while either owner is flagged", () => {
		expect(() =>
			refuseFlaggedOwnershipTransfer({
				sourceOwnerId: "owner-flagged",
				targetOwnerId: "owner-plain",
				env,
			}),
		).toThrow(/refused/i);
		expect(() =>
			refuseFlaggedOwnershipTransfer({
				sourceOwnerId: "owner-plain",
				targetOwnerId: "owner-flagged",
				env,
			}),
		).toThrow(/refused/i);
		expect(() =>
			refuseFlaggedOwnershipTransfer({
				sourceOwnerId: "owner-plain",
				targetOwnerId: "owner-other",
				env,
			}),
		).not.toThrow();
	});
});

describe("F5 current generation stays on R1 until the flip", () => {
	it("keeps R1 playable while R2 is allocated or failed, then 410s R1", async () => {
		const { classifyServingPublication } = await import(
			"@/lib/revision-serving"
		);
		const token = signRevisionMediaGrant(
			{
				videoId: "video1",
				revisionId: "r1",
				publicationEpoch: 1,
				policyEpoch: 4,
				now,
			},
			env,
		);
		expect(verifyRevisionMediaGrant(token, { now, env }).ok).toBe(true);
		const preparing = {
			currentRevisionId: "r1",
			currentGeneration: 1,
			allocatedGeneration: 2,
			publicationEpoch: 1,
			policyEpoch: 4,
		};
		expect(
			classifyServingPublication({
				revisionId: "r1",
				revisionGeneration: 1,
				...preparing,
			}),
		).toEqual({ ok: true });
		expect(
			classifyLiveGrant(
				token,
				{
					videoId: "video1",
					revisionId: "r1",
					publicationEpoch: preparing.publicationEpoch,
					policyEpoch: preparing.policyEpoch,
					currentRevisionId: preparing.currentRevisionId,
					deleted: false,
					privateOrUnauthorized: false,
				},
				{ now, env },
			).ok,
		).toBe(true);
		const current = {
			...preparing,
			currentRevisionId: "r2",
			currentGeneration: 2,
			publicationEpoch: 2,
		};
		expect(
			classifyServingPublication({
				revisionId: "r1",
				revisionGeneration: 1,
				...current,
			}),
		).toEqual({ ok: false, status: 410, reason: "non_current" });
		expect(
			classifyLiveGrant(
				token,
				{
					videoId: "video1",
					revisionId: "r1",
					publicationEpoch: current.publicationEpoch,
					policyEpoch: current.policyEpoch,
					currentRevisionId: current.currentRevisionId,
					deleted: false,
					privateOrUnauthorized: false,
				},
				{ now, env },
			),
		).toMatchObject({ ok: false, status: 410 });
	});

	it("requires Finish SourceId to use the relocated liveKey", async () => {
		const { assertFinishSourceKey } = await import("@/lib/source-relocation");
		expect(() =>
			assertFinishSourceKey({
				liveKey: "owner/video/source/original.mp4",
				relocations: [
					{ newKey: "private/source/video/opaque", state: "DELETED" },
				],
			}),
		).toThrow(/relocated liveKey/);
		expect(
			assertFinishSourceKey({
				liveKey: "private/source/video/opaque",
				relocations: [
					{ newKey: "private/source/video/opaque", state: "DELETED" },
				],
			}),
		).toBe("private/source/video/opaque");
	});

	it("amends migration 0047 with nullable currentGeneration", () => {
		const sql = readFileSync(
			path.resolve(
				path.dirname(fileURLToPath(import.meta.url)),
				"../../../../packages/database/migrations/0047_brown_spitfire.sql",
			),
			"utf8",
		);
		expect(sql).toContain("`currentGeneration` int");
		expect(sql).not.toContain("`currentGeneration` int NOT NULL");
	});
});

describe("F10 revision metadata is frozen at Finish", () => {
	it("does not let a later videos.metadata write change R1", async () => {
		const { pageMetadataForRevision } = await import(
			"@/lib/revision-metadata-snapshot"
		);
		const snapshot = {
			captionsVtt: "WEBVTT\n",
			chapters: [{ title: "Intro", start: 0 }],
			summaryStatus: "persisted" as const,
			summaryDerived: false as const,
			summaryText: "owner pasted summary",
			thumbnail: "seg0-first-frame" as const,
			durationSeconds: 12,
		};
		const page = pageMetadataForRevision({
			snapshot,
			liveMetadata: {
				chapters: [{ title: "Later", start: 9 }],
				summary: "rewritten later",
			},
		});
		expect(page.chapters).toEqual(snapshot.chapters);
		expect(page.summaryText).toBe("owner pasted summary");
		expect(page.summaryDerived).toBe(false);
		expect(page.summaryStatus).toBe("persisted");
	});
});

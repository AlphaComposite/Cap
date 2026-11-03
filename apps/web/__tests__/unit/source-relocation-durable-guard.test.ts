import { readFileSync } from "node:fs";
import {
	DeleteObjectCommand,
	ListObjectVersionsCommand,
	type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
	assertFinishInventoryClear,
	continueRelocation,
	createMemoryJournal,
	inventoryExposedKeys,
	isFinishInventoryExempt,
	type ObjectStore,
	reconcileRelocations,
	relocateKey,
	relocateOwnerVideo,
} from "@/lib/source-relocation";
import { createS3Store } from "../../scripts/instant-finish-relocate";

const prefix = "owner/video/";
const protectedKeys = [
	`${prefix}private/edited/revision/7/attempt.mp4`,
	`${prefix}private/edited/revision/7/hls/segment.m4s`,
	`${prefix}private/edited/bad-receipt/not-a-generation/unknown`,
	`${prefix}private/edited/../result.mp4`,
	`${prefix}private/edited/`,
	`${prefix}private/edited`,
];
const states = ["INTENT", "COPIED", "POINTER", "DELETED"] as const;
const refusal = /durable edited artifact/;

function offlineStore(): ObjectStore {
	return {
		copy: vi.fn(async () => undefined),
		sha256: vi.fn(async () => "corrupt-copy"),
		deleteAllVersions: vi.fn(async () => undefined),
		exists: vi.fn(async () => false),
		presignGet: vi.fn(async (key) => key),
		request: vi.fn(async () => 404),
	};
}

function expectNoStoreCalls(store: ObjectStore) {
	for (const method of Object.values(store))
		expect(method).not.toHaveBeenCalled();
}

describe("durable edited relocation boundary (offline transport doubles)", () => {
	it.each(protectedKeys)(
		"retains %s in inventory and Finish without validating receipts",
		(key) => {
			const inventory = inventoryExposedKeys({
				ownerId: "owner",
				videoId: "video",
				sourceKey: key,
				rawFileKey: key,
				outputKey: key,
				extraKeys: [key],
			});
			expect(inventory.map((item) => item.key)).not.toContain(key);
			expect(isFinishInventoryExempt(key, prefix)).toBe(true);
			expect(() => assertFinishInventoryClear([key], prefix)).not.toThrow();
			expect(isFinishInventoryExempt(key, "other/video/")).toBe(false);
		},
	);

	it.each([
		`${prefix}private/edited-copy/file.mp4`,
		`${prefix}x/private/edited/revision/7/file.mp4`,
		`${prefix}result.mp4`,
	])("keeps exposed lookalike %s eligible", (key) => {
		expect(
			inventoryExposedKeys({
				ownerId: "owner",
				videoId: "video",
				extraKeys: [key],
			}).map((item) => item.key),
		).toContain(key);
		expect(isFinishInventoryExempt(key, prefix)).toBe(false);
	});

	it.each(states)(
		"refuses protected old-key %s resume before effects or journal advancement",
		async (state) => {
			const journal = createMemoryJournal();
			const row = await journal.insertIntent({
				videoId: "video",
				revisionId: "revision",
				oldKey: protectedKeys[0],
				newKey: "private/rollback/video/copy",
				sha256: "expected",
				state,
			});
			const store = offlineStore();
			const purge = { purge: vi.fn(async () => ({ accepted: true })) };
			await expect(
				continueRelocation(row, store, journal, {
					kind: "rollback",
					purge,
					purgeUrls: ["https://offline.invalid/old"],
				}),
			).rejects.toThrow(refusal);
			expectNoStoreCalls(store);
			expect(purge.purge).not.toHaveBeenCalled();
			expect(row.state).toBe(state);
			expect(journal.live.size).toBe(0);
		},
	);

	it.each(states)(
		"independently refuses protected %s reconciliation including corrupt copies",
		async (state) => {
			const journal = createMemoryJournal();
			const row = await journal.insertIntent({
				videoId: "video",
				revisionId: "revision",
				oldKey: protectedKeys[0],
				newKey: "private/rollback/video/copy",
				sha256: "expected",
				state,
			});
			const store = offlineStore();
			await expect(
				reconcileRelocations({ store, journal, kindFor: () => "rollback" }),
			).rejects.toThrow(refusal);
			expectNoStoreCalls(store);
			expect(row.state).toBe(state);
		},
	);

	it.each(["resume", "reconcile", "new"] as const)(
		"rejects protected destinations before %s can overwrite or clean up a corrupt copy",
		async (mode) => {
			const journal = createMemoryJournal();
			const input = {
				videoId: "video",
				revisionId: "revision",
				oldKey: `${prefix}result.mp4`,
				newKey: protectedKeys[2],
				sha256: "expected",
				state: "INTENT" as const,
			};
			const store = offlineStore();
			const row = await journal.insertIntent(input);
			const operation =
				mode === "resume"
					? continueRelocation(row, store, journal, { kind: "rollback" })
					: mode === "reconcile"
						? reconcileRelocations({
								store,
								journal,
								kindFor: () => "rollback",
							})
						: relocateKey({ ...input, kind: "rollback", store, journal });
			await expect(operation).rejects.toThrow(refusal);
			expectNoStoreCalls(store);
			expect(row.state).toBe("INTENT");
			expect(journal.rows).toHaveLength(1);
		},
	);

	it("does not let owner inventory silently bypass a protected pending row", async () => {
		const journal = createMemoryJournal();
		const row = await journal.insertIntent({
			videoId: "video",
			revisionId: "revision",
			oldKey: protectedKeys[0],
			newKey: "private/rollback/video/copy",
			sha256: "expected",
			state: "COPIED",
		});
		const store = offlineStore();
		await expect(
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
			}),
		).rejects.toThrow(refusal);
		expectNoStoreCalls(store);
		expect(row.state).toBe("COPIED");
	});

	it.each(["reconcile", "owner", "owner-reconcile"])(
		"preflights the whole mixed journal before any %s object effect",
		async (mode) => {
			const journal = createMemoryJournal();
			for (const oldKey of [
				`${prefix}result.mp4`,
				`${prefix}private/edited/revision/7/attempt.mp4`,
			])
				await journal.insertIntent({
					videoId: "video",
					revisionId: "revision",
					oldKey,
					newKey: `private/rollback/video/${journal.rows.length}`,
					sha256: "expected",
					state: "INTENT",
				});
			const before = JSON.stringify(journal.rows);
			const store = {
				...offlineStore(),
				list: vi.fn(async () => [`${prefix}result.mp4`]),
			};
			await expect(
				mode === "reconcile"
					? reconcileRelocations({ store, journal, kindFor: () => "rollback" })
					: relocateOwnerVideo({
							ownerId: "owner",
							videoId: "video",
							store,
							journal,
							reconcileOnly: mode === "owner-reconcile",
						}),
			).rejects.toThrow(refusal);
			expectNoStoreCalls(store);
			expect(JSON.stringify(journal.rows)).toBe(before);
			expect(journal.live.size).toBe(0);
		},
	);

	it("prepared inventory validates pending rows before its first object listing (source ordering)", () => {
		const source = readFileSync(
			new URL("../../lib/instant-finish-source-relocate.ts", import.meta.url),
			"utf8",
		);
		const body = source.slice(
			source.indexOf("export async function completePreparedSourceInventory"),
		);
		expect(
			body.indexOf("inventory completion encountered an unsafe relocation row"),
		).toBeGreaterThan(0);
		expect(
			body.indexOf("inventory completion encountered an unsafe relocation row"),
		).toBeLessThan(body.indexOf("const listed = await store.list(prefix)"));
	});

	it.each(protectedKeys)(
		"direct deletion of %s emits zero SDK commands",
		async (key) => {
			const send = vi.fn(async () => ({}));
			const store = createS3Store(
				{ send } as unknown as S3Client,
				"offline-bucket",
			);
			await expect(store.deleteAllVersions(key)).rejects.toThrow(refusal);
			expect(send).not.toHaveBeenCalled();
		},
	);

	it.each([true, false])(
		"preserves public deletion with explicit versions=%s in an offline SDK",
		async (versioned) => {
			const key = `${prefix}result.mp4`;
			const send = vi.fn(async (command: unknown) =>
				command instanceof ListObjectVersionsCommand
					? {
							Versions: versioned
								? [
										{ Key: key, VersionId: "version-1" },
										{ Key: `${key}.other`, VersionId: "unrelated" },
									]
								: [],
							DeleteMarkers: versioned
								? [{ Key: key, VersionId: "marker-1" }]
								: [],
						}
					: {},
			);
			const store = createS3Store(
				{ send } as unknown as S3Client,
				"offline-bucket",
			);
			await store.deleteAllVersions(key);
			expect(send.mock.calls[0][0]).toBeInstanceOf(ListObjectVersionsCommand);
			const deletes = send.mock.calls
				.map(([command]) => command)
				.filter((command) => command instanceof DeleteObjectCommand);
			expect(deletes.map((command) => command.input)).toEqual(
				versioned
					? [
							{ Bucket: "offline-bucket", Key: key, VersionId: "version-1" },
							{ Bucket: "offline-bucket", Key: key, VersionId: "marker-1" },
						]
					: [{ Bucket: "offline-bucket", Key: key }],
			);
		},
	);
});

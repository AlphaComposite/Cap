import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RevisionPublicationError } from "@/lib/revision-publication-metadata";
import {
	assertFinishInventoryClear,
	assertFinishSourceKey,
	createMemoryJournal,
	inventoryExposedKeys,
	isFinishInventoryExempt,
	type ObjectStore,
	relocateOwnerVideo,
} from "@/lib/source-relocation";

describe("finish source relocation gate", () => {
	it("refuses an unrelocated liveKey and a relocation that is not PURGED", () => {
		expect(() =>
			assertFinishSourceKey({
				liveKey: "owner/video/source/original.mp4",
				relocations: [],
			}),
		).toThrow(/PURGED/);
		expect(() =>
			assertFinishSourceKey({
				liveKey: "private/source/video/opaque",
				relocations: [
					{ newKey: "private/source/video/opaque", state: "DELETED" },
				],
			}),
		).toThrow(/PURGED/);
	});

	it("accepts only the purged private key that matches liveKey", () => {
		expect(
			assertFinishSourceKey({
				liveKey: "private/source/video/opaque",
				relocations: [
					{ newKey: "private/source/video/opaque", state: "PURGED" },
				],
			}),
		).toBe("private/source/video/opaque");
	});

	it("revokes every preissued old key and refuses publish until the purge is recorded", async () => {
		const body = Buffer.from("source-bytes");
		const objects = new Map<string, Buffer>([
			["owner/video/source/original.mp4", body],
			["owner/video/raw-upload.mp4", body],
			["owner/video/.recording/outputs/result.mp4", body],
		]);
		const signed = new Map<string, string>();
		const store: ObjectStore = {
			async copy(oldKey, newKey) {
				const found = objects.get(oldKey);
				if (!found) throw new Error("missing");
				objects.set(newKey, Buffer.from(found));
			},
			async sha256(key) {
				const found = objects.get(key);
				return found ? createHash("sha256").update(found).digest("hex") : null;
			},
			async deleteAllVersions(key) {
				objects.delete(key);
			},
			async exists(key) {
				return objects.has(key);
			},
			async presignGet(key) {
				const url = `https://minio.local/${key}?get=1`;
				signed.set(url, key);
				return url;
			},
			async presignHead(key) {
				const url = `https://minio.local/${key}?head=1`;
				signed.set(url, key);
				return url;
			},
			async list(prefix) {
				return [...objects.keys()].filter((key) => key.startsWith(prefix));
			},
			async listVersions(key) {
				return objects.has(key) ? ["v1"] : [];
			},
			async request(url) {
				const key = signed.get(url);
				return key && objects.has(key) ? 200 : 404;
			},
		};
		const issued = await Promise.all(
			[...objects.keys()].map(async (key) => store.presignGet(key)),
		);
		for (const url of issued) expect(await store.request(url, "GET")).toBe(200);
		const journal = createMemoryJournal();
		expect(() =>
			assertFinishSourceKey({
				liveKey: "owner/video/source/original.mp4",
				relocations: journal.rows,
			}),
		).toThrow(/PURGED/);
		const proof = await relocateOwnerVideo({
			ownerId: "owner",
			videoId: "video",
			store,
			journal,
			sourceKey: "owner/video/source/original.mp4",
			rawFileKey: "owner/video/raw-upload.mp4",
			outputKey: "owner/video/.recording/outputs/result.mp4",
		});
		for (const url of issued) expect(await store.request(url, "GET")).toBe(404);
		expect(proof.liveKeyPrivate).toBe(true);
		expect(
			assertFinishSourceKey({
				liveKey: proof.liveKey ?? "",
				relocations: journal.rows,
			}),
		).toBe(proof.liveKey);
		await expect(
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "missing",
				store,
				journal: createMemoryJournal(),
			}),
		).rejects.toThrow(/no-op/);
	});

	it("keeps transcript objects and relocates result.mp4", async () => {
		const body = Buffer.from("source-bytes");
		const objects = new Map<string, Buffer>([
			["owner/vid/source/original.mp4", body],
			["owner/vid/result.mp4", body],
			["owner/vid/transcription.vtt", Buffer.from("WEBVTT\n")],
			["owner/vid/transcription.en.vtt", Buffer.from("WEBVTT\n")],
			["owner/vid/transcription.edit.v3.json", Buffer.from("{}")],
			["owner/vid/transcription.edit.v3.status.json", Buffer.from("{}")],
		]);
		const signed = new Map<string, string>();
		const store: ObjectStore = {
			async copy(oldKey, newKey) {
				const found = objects.get(oldKey);
				if (!found) throw new Error("missing");
				objects.set(newKey, Buffer.from(found));
			},
			async sha256(key) {
				const found = objects.get(key);
				return found ? createHash("sha256").update(found).digest("hex") : null;
			},
			async deleteAllVersions(key) {
				objects.delete(key);
			},
			async exists(key) {
				return objects.has(key);
			},
			async presignGet(key) {
				const url = `https://minio.local/${key}?get=1`;
				signed.set(url, key);
				return url;
			},
			async list(prefix) {
				return [...objects.keys()].filter((key) => key.startsWith(prefix));
			},
			async listVersions(key) {
				return objects.has(key) ? ["v1"] : [];
			},
			async request(url) {
				const key = signed.get(url);
				return key && objects.has(key) ? 200 : 404;
			},
		};
		await relocateOwnerVideo({
			ownerId: "owner",
			videoId: "vid",
			store,
			journal: createMemoryJournal(),
			sourceKey: "owner/vid/source/original.mp4",
		});
		expect(objects.has("owner/vid/result.mp4")).toBe(false);
		expect(objects.has("owner/vid/source/original.mp4")).toBe(false);
		expect(objects.has("owner/vid/transcription.vtt")).toBe(true);
		expect(objects.has("owner/vid/transcription.en.vtt")).toBe(true);
		expect(objects.has("owner/vid/transcription.edit.v3.json")).toBe(true);
		expect(objects.has("owner/vid/transcription.edit.v3.status.json")).toBe(
			true,
		);
	});
});

const LOOKALIKE_PREFIX = "owner/vid/";
const NESTED_LOOKALIKES = [
	`${LOOKALIKE_PREFIX}segments/transcription.vtt`,
	`${LOOKALIKE_PREFIX}x/transcription.edit.v3.json`,
	`${LOOKALIKE_PREFIX}x/private/source/y`,
	`${LOOKALIKE_PREFIX}x/private/rollback/y`,
];
const RETAINED_TRANSCRIPTS = [
	`${LOOKALIKE_PREFIX}transcription.vtt`,
	`${LOOKALIKE_PREFIX}transcription.en.vtt`,
	`${LOOKALIKE_PREFIX}transcription.edit.v3.json`,
	`${LOOKALIKE_PREFIX}transcription.edit.v3.status.json`,
];
const RETAINED_COMMENT = `${LOOKALIKE_PREFIX}comments/c1/media.mp4`;

describe("old-key lookalike fence", () => {
	it("inventories nested lookalikes and not the exact retained keys", () => {
		const keys = inventoryExposedKeys({
			ownerId: "owner",
			videoId: "vid",
			extraKeys: [
				...NESTED_LOOKALIKES,
				...RETAINED_TRANSCRIPTS,
				RETAINED_COMMENT,
			],
		}).map((item) => item.key);
		for (const key of NESTED_LOOKALIKES) expect(keys).toContain(key);
		for (const key of RETAINED_TRANSCRIPTS) expect(keys).not.toContain(key);
	});

	it("Finish refuses each nested lookalike with 409 and keeps exact exemptions", () => {
		for (const key of NESTED_LOOKALIKES) {
			let caught: unknown;
			try {
				assertFinishInventoryClear([key], LOOKALIKE_PREFIX);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(RevisionPublicationError);
			expect((caught as RevisionPublicationError).status).toBe(409);
		}
		expect(() =>
			assertFinishInventoryClear(
				[...RETAINED_TRANSCRIPTS, RETAINED_COMMENT],
				LOOKALIKE_PREFIX,
			),
		).not.toThrow();
		for (const key of RETAINED_TRANSCRIPTS) {
			expect(isFinishInventoryExempt(key, LOOKALIKE_PREFIX)).toBe(true);
		}
		expect(isFinishInventoryExempt(RETAINED_COMMENT, LOOKALIKE_PREFIX)).toBe(
			true,
		);
	});

	it("relocates nested lookalikes and leaves exact transcript keys", async () => {
		const body = Buffer.from("source-bytes");
		const objects = new Map<string, Buffer>([
			[`${LOOKALIKE_PREFIX}source/original.mp4`, body],
			...NESTED_LOOKALIKES.map((key) => [key, body] as const),
			...RETAINED_TRANSCRIPTS.map(
				(key) => [key, Buffer.from("WEBVTT\n")] as const,
			),
			[RETAINED_COMMENT, body],
		]);
		const signed = new Map<string, string>();
		const store: ObjectStore = {
			async copy(oldKey, newKey) {
				const found = objects.get(oldKey);
				if (!found) throw new Error("missing");
				objects.set(newKey, Buffer.from(found));
			},
			async sha256(key) {
				const found = objects.get(key);
				return found ? createHash("sha256").update(found).digest("hex") : null;
			},
			async deleteAllVersions(key) {
				objects.delete(key);
			},
			async exists(key) {
				return objects.has(key);
			},
			async presignGet(key) {
				const url = `https://minio.local/${key}?get=1`;
				signed.set(url, key);
				return url;
			},
			async list(prefix) {
				return [...objects.keys()].filter((key) => key.startsWith(prefix));
			},
			async listVersions(key) {
				return objects.has(key) ? ["v1"] : [];
			},
			async request(url) {
				const key = signed.get(url);
				return key && objects.has(key) ? 200 : 404;
			},
		};
		await relocateOwnerVideo({
			ownerId: "owner",
			videoId: "vid",
			store,
			journal: createMemoryJournal(),
			sourceKey: `${LOOKALIKE_PREFIX}source/original.mp4`,
		});
		for (const key of NESTED_LOOKALIKES) expect(objects.has(key)).toBe(false);
		for (const key of RETAINED_TRANSCRIPTS) expect(objects.has(key)).toBe(true);
	});
});

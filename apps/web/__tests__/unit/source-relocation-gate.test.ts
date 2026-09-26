import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	assertFinishSourceKey,
	createMemoryJournal,
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
});

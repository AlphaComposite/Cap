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

function createProbeStore(
	objects: Map<string, Buffer>,
	stickyAfterDelete?: { get?: number; head?: number; range?: number },
) {
	const signed = new Map<string, string>();
	const deleted = new Set<string>();
	const store: ObjectStore = {
		async copy(oldKey, newKey) {
			if (objects.has(newKey)) {
				throw new Error(`refusing to overwrite ${newKey}`);
			}
			const found = objects.get(oldKey);
			if (!found) throw new Error("missing");
			objects.set(newKey, Buffer.from(found));
		},
		async sha256(key) {
			const found = objects.get(key);
			return found ? createHash("sha256").update(found).digest("hex") : null;
		},
		async deleteAllVersions(key) {
			if (objects.has(key)) deleted.add(key);
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
		async request(url, method, range) {
			const key = signed.get(url);
			if (!key) return 404;
			if (!objects.has(key)) {
				if (range && stickyAfterDelete?.range !== undefined) {
					return stickyAfterDelete.range;
				}
				if (method === "HEAD" && stickyAfterDelete?.head !== undefined) {
					return stickyAfterDelete.head;
				}
				if (method === "GET" && stickyAfterDelete?.get !== undefined) {
					return stickyAfterDelete.get;
				}
				return 404;
			}
			return 200;
		},
	};
	return { store, signed, deleted };
}

describe("open relocation resume", () => {
	it("resumes a copied protected result and revokes preissued reads", async () => {
		const original = Buffer.from("original-bytes");
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/video/copied-result";
		const objects = new Map<string, Buffer>([
			["owner/video/source/original.mp4", original],
			[resultKey, result],
			[privateCopy, Buffer.from(result)],
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
		const journal = createMemoryJournal();
		const resultSha = createHash("sha256").update(result).digest("hex");
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: resultSha,
			state: "COPIED",
		});
		const proof = await relocateOwnerVideo({
			ownerId: "owner",
			videoId: "video",
			store,
			journal,
			sourceKey: "owner/video/source/original.mp4",
		});
		for (const [url] of signed) {
			expect(await store.request(url, "GET")).toBeGreaterThanOrEqual(400);
			expect(await store.request(url, "HEAD")).toBeGreaterThanOrEqual(400);
			expect(
				await store.request(url, "GET", "bytes=0-0"),
			).toBeGreaterThanOrEqual(400);
		}
		expect(proof.liveKeyPrivate).toBe(true);
		expect(proof.liveKey?.startsWith("private/source/video/")).toBe(true);
		expect(open.state).toBe("PURGED");
		expect(open.newKey).toBe(privateCopy);
		expect(objects.has(resultKey)).toBe(false);
		expect(objects.has("owner/video/source/original.mp4")).toBe(false);
		expect(objects.get(privateCopy)?.equals(result)).toBe(true);
		expect(
			journal.rows.some(
				(row) => row.state === "PURGED" && row.newKey === proof.liveKey,
			),
		).toBe(true);
	});

	it("resumes an intent protected result without a private copy yet", async () => {
		const original = Buffer.from("original-bytes");
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/video/intent-result";
		const objects = new Map<string, Buffer>([
			["owner/video/source/original.mp4", original],
			[resultKey, result],
		]);
		const signed = new Map<string, string>();
		const store: ObjectStore = {
			async copy(oldKey, newKey) {
				if (objects.has(newKey))
					throw new Error(`refusing to overwrite ${newKey}`);
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
		const journal = createMemoryJournal();
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: createHash("sha256").update(result).digest("hex"),
			state: "INTENT",
		});
		const proof = await relocateOwnerVideo({
			ownerId: "owner",
			videoId: "video",
			store,
			journal,
			sourceKey: "owner/video/source/original.mp4",
		});
		expect(open.state).toBe("PURGED");
		expect(open.newKey).toBe(privateCopy);
		expect(objects.get(privateCopy)?.equals(result)).toBe(true);
		expect(objects.has(resultKey)).toBe(false);
		expect(proof.liveKeyPrivate).toBe(true);
		for (const [url] of signed) {
			expect(await store.request(url, "GET")).toBeGreaterThanOrEqual(400);
			expect(await store.request(url, "HEAD")).toBeGreaterThanOrEqual(400);
			expect(
				await store.request(url, "GET", "bytes=0-0"),
			).toBeGreaterThanOrEqual(400);
		}
	});

	it("resumes a pointer protected result from the verified private copy", async () => {
		const original = Buffer.from("original-bytes");
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/video/pointer-result";
		const objects = new Map<string, Buffer>([
			["owner/video/source/original.mp4", original],
			[resultKey, result],
			[privateCopy, Buffer.from(result)],
		]);
		const { store, signed } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: createHash("sha256").update(result).digest("hex"),
			state: "POINTER",
		});
		const proof = await relocateOwnerVideo({
			ownerId: "owner",
			videoId: "video",
			store,
			journal,
			sourceKey: "owner/video/source/original.mp4",
		});
		expect(open.state).toBe("PURGED");
		expect(open.newKey).toBe(privateCopy);
		expect(objects.get(privateCopy)?.equals(result)).toBe(true);
		expect(objects.has(resultKey)).toBe(false);
		expect(proof.liveKey?.startsWith("private/source/video/")).toBe(true);
		for (const [url] of signed) {
			expect(await store.request(url, "GET")).toBeGreaterThanOrEqual(400);
			expect(await store.request(url, "HEAD")).toBeGreaterThanOrEqual(400);
			expect(
				await store.request(url, "GET", "bytes=0-0"),
			).toBeGreaterThanOrEqual(400);
		}
	});

	it("finishes a deleted protected result whose public object is already gone", async () => {
		const original = Buffer.from("original-bytes");
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/video/deleted-result";
		const objects = new Map<string, Buffer>([
			["owner/video/source/original.mp4", original],
			[privateCopy, Buffer.from(result)],
		]);
		const { store, signed } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: createHash("sha256").update(result).digest("hex"),
			state: "DELETED",
		});
		const proof = await relocateOwnerVideo({
			ownerId: "owner",
			videoId: "video",
			store,
			journal,
			sourceKey: "owner/video/source/original.mp4",
		});
		expect(open.state).toBe("PURGED");
		expect(open.newKey).toBe(privateCopy);
		expect(objects.get(privateCopy)?.equals(result)).toBe(true);
		expect(objects.has(resultKey)).toBe(false);
		expect(proof.liveKey?.startsWith("private/source/video/")).toBe(true);
		for (const [url] of signed) {
			expect(await store.request(url, "GET")).toBeGreaterThanOrEqual(400);
			expect(await store.request(url, "HEAD")).toBeGreaterThanOrEqual(400);
			expect(
				await store.request(url, "GET", "bytes=0-0"),
			).toBeGreaterThanOrEqual(400);
		}
	});

	it("throws when a preissued GET stays readable after delete", async () => {
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/video/sticky-get";
		const objects = new Map<string, Buffer>([
			["owner/video/source/original.mp4", Buffer.from("original-bytes")],
			[resultKey, result],
			[privateCopy, Buffer.from(result)],
		]);
		const { store } = createProbeStore(objects, { get: 200 });
		const journal = createMemoryJournal();
		await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: createHash("sha256").update(result).digest("hex"),
			state: "COPIED",
		});
		await expect(
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
				sourceKey: "owner/video/source/original.mp4",
			}),
		).rejects.toThrow(/preissued url still readable after delete/);
		expect(journal.rows.some((row) => row.state === "PURGED")).toBe(false);
	});

	it("throws when a preissued range stays readable after delete", async () => {
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/video/sticky-range";
		const objects = new Map<string, Buffer>([
			["owner/video/source/original.mp4", Buffer.from("original-bytes")],
			[resultKey, result],
			[privateCopy, Buffer.from(result)],
		]);
		const { store } = createProbeStore(objects, { range: 206 });
		const journal = createMemoryJournal();
		await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: createHash("sha256").update(result).digest("hex"),
			state: "COPIED",
		});
		await expect(
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
				sourceKey: "owner/video/source/original.mp4",
			}),
		).rejects.toThrow(/preissued url still readable after delete/);
		expect(journal.rows.some((row) => row.state === "PURGED")).toBe(false);
	});

	it("does not delete the public object when the private copy is missing", async () => {
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/video/missing-copy";
		const objects = new Map<string, Buffer>([[resultKey, result]]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: createHash("sha256").update(result).digest("hex"),
			state: "COPIED",
		});
		await expect(
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
			}),
		).rejects.toThrow(/refusing to delete old key without a verified copy/);
		expect(objects.has(resultKey)).toBe(true);
		expect(objects.has(privateCopy)).toBe(false);
		expect(open.state).not.toBe("PURGED");
	});

	it("does not delete the public object when the private copy hash is wrong", async () => {
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/video/wrong-copy";
		const wrong = Buffer.from("not-the-result");
		const objects = new Map<string, Buffer>([
			[resultKey, result],
			[privateCopy, wrong],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: createHash("sha256").update(result).digest("hex"),
			state: "COPIED",
		});
		await expect(
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
			}),
		).rejects.toThrow(/refusing to delete old key without a verified copy/);
		expect(objects.has(resultKey)).toBe(true);
		expect(objects.get(privateCopy)?.equals(wrong)).toBe(true);
		expect(open.state).not.toBe("PURGED");
	});

	it("does not resume an open row for a different video", async () => {
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/other/copied-result";
		const originalKey = "owner/video/source/original.mp4";
		const objects = new Map<string, Buffer>([
			[originalKey, Buffer.from("original-bytes")],
			[resultKey, result],
			[privateCopy, Buffer.from(result)],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const open = await journal.insertIntent({
			videoId: "other",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: createHash("sha256").update(result).digest("hex"),
			state: "COPIED",
		});
		await expect(
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
				sourceKey: originalKey,
			}),
		).rejects.toThrow(/open relocation video mismatch/);
		expect(objects.has(resultKey)).toBe(true);
		expect(objects.has(originalKey)).toBe(true);
		expect(objects.get(privateCopy)?.equals(result)).toBe(true);
		expect(open.state).toBe("COPIED");
		expect(await journal.getLiveKey("video")).toBeNull();
	});

	it("does not resume when two open rows match the same key", async () => {
		const original = Buffer.from("original-bytes");
		const originalKey = "owner/video/source/original.mp4";
		const objects = new Map<string, Buffer>([[originalKey, original]]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const sha = createHash("sha256").update(original).digest("hex");
		const first = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: originalKey,
			newKey: "private/source/video/first",
			sha256: sha,
			state: "COPIED",
		});
		const second = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: originalKey,
			newKey: "private/source/video/second",
			sha256: sha,
			state: "COPIED",
		});
		objects.set("private/source/video/first", Buffer.from(original));
		objects.set("private/source/video/second", Buffer.from(original));
		await expect(
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
				sourceKey: originalKey,
			}),
		).rejects.toThrow(/ambiguous open relocation/);
		expect(objects.has(originalKey)).toBe(true);
		expect(first.state).toBe("COPIED");
		expect(second.state).toBe("COPIED");
		expect(await journal.getLiveKey("video")).toBeNull();
	});

	it("does not let two original rows replace liveKey", async () => {
		const body = Buffer.from("original-bytes");
		const firstKey = "owner/video/source/original.mp4";
		const secondKey = "owner/video/source/other.mp4";
		const firstPrivate = "private/source/video/first-live";
		const secondPrivate = "private/source/video/second-live";
		const objects = new Map<string, Buffer>([
			[firstKey, body],
			[secondKey, Buffer.from(body)],
			[firstPrivate, Buffer.from(body)],
			[secondPrivate, Buffer.from(body)],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const sha = createHash("sha256").update(body).digest("hex");
		const first = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: firstKey,
			newKey: firstPrivate,
			sha256: sha,
			state: "COPIED",
		});
		const second = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: secondKey,
			newKey: secondPrivate,
			sha256: sha,
			state: "COPIED",
		});
		await expect(
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
				sourceKey: firstKey,
			}),
		).rejects.toThrow(/multiple original relocations would change liveKey/);
		expect(objects.has(firstKey)).toBe(true);
		expect(objects.has(secondKey)).toBe(true);
		expect(first.state).toBe("COPIED");
		expect(second.state).toBe("COPIED");
		expect(await journal.getLiveKey("video")).toBeNull();
	});

	it("does not let one open original row and a fresh original replace liveKey", async () => {
		const body = Buffer.from("original-bytes");
		const originalKey = "owner/video/source/original.mp4";
		const otherKey = "owner/video/source/other.mp4";
		const otherPrivate = "private/source/video/other-live";
		const objects = new Map<string, Buffer>([
			[originalKey, body],
			[otherKey, Buffer.from(body)],
			[otherPrivate, Buffer.from(body)],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: otherKey,
			newKey: otherPrivate,
			sha256: createHash("sha256").update(body).digest("hex"),
			state: "COPIED",
		});
		await expect(
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
				sourceKey: originalKey,
			}),
		).rejects.toThrow(/multiple original relocations would change liveKey/);
		expect(objects.has(originalKey)).toBe(true);
		expect(objects.has(otherKey)).toBe(true);
		expect(open.state).toBe("COPIED");
		expect(await journal.getLiveKey("video")).toBeNull();
	});

	it("does not overwrite an existing verified private copy", async () => {
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/video/kept-copy";
		const objects = new Map<string, Buffer>([
			["owner/video/source/original.mp4", Buffer.from("original-bytes")],
			[resultKey, result],
			[privateCopy, Buffer.from(result)],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: createHash("sha256").update(result).digest("hex"),
			state: "INTENT",
		});
		const proof = await relocateOwnerVideo({
			ownerId: "owner",
			videoId: "video",
			store,
			journal,
			sourceKey: "owner/video/source/original.mp4",
		});
		expect(open.state).toBe("PURGED");
		expect(open.newKey).toBe(privateCopy);
		expect(objects.get(privateCopy)?.equals(result)).toBe(true);
		expect(proof.liveKey?.startsWith("private/source/video/")).toBe(true);
	});

	it("keeps transcript objects while resuming a copied result", async () => {
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/video/copied-result";
		const transcripts = [
			"owner/video/transcription.vtt",
			"owner/video/transcription.en.vtt",
			"owner/video/transcription.edit.v3.json",
			"owner/video/transcription.edit.v3.status.json",
		];
		const objects = new Map<string, Buffer>([
			["owner/video/source/original.mp4", Buffer.from("original-bytes")],
			[resultKey, result],
			[privateCopy, Buffer.from(result)],
			...transcripts.map((key) => [key, Buffer.from("WEBVTT\n")] as const),
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: createHash("sha256").update(result).digest("hex"),
			state: "COPIED",
		});
		await relocateOwnerVideo({
			ownerId: "owner",
			videoId: "video",
			store,
			journal,
			sourceKey: "owner/video/source/original.mp4",
		});
		expect(objects.has(resultKey)).toBe(false);
		for (const key of transcripts) expect(objects.has(key)).toBe(true);
	});

	it("does not accept an aborted row as a successful privacy proof", async () => {
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const abortedKey = "private/rollback/video/aborted-result";
		const objects = new Map<string, Buffer>([
			["owner/video/source/original.mp4", Buffer.from("original-bytes")],
			[resultKey, result],
		]);
		const { store, signed } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const aborted = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: abortedKey,
			sha256: createHash("sha256").update(result).digest("hex"),
			state: "ABORTED",
		});
		const proof = await relocateOwnerVideo({
			ownerId: "owner",
			videoId: "video",
			store,
			journal,
			sourceKey: "owner/video/source/original.mp4",
		});
		expect(aborted.state).toBe("ABORTED");
		expect(objects.has(resultKey)).toBe(false);
		expect(proof.liveKey).not.toBe(abortedKey);
		expect(proof.liveKeyPrivate).toBe(true);
		expect(
			journal.rows.some(
				(row) =>
					row.id !== aborted.id &&
					row.oldKey === resultKey &&
					row.state === "PURGED",
			),
		).toBe(true);
		for (const [url] of signed) {
			expect(await store.request(url, "GET")).toBeGreaterThanOrEqual(400);
			expect(await store.request(url, "HEAD")).toBeGreaterThanOrEqual(400);
			expect(
				await store.request(url, "GET", "bytes=0-0"),
			).toBeGreaterThanOrEqual(400);
		}
	});

	it("rejects a same-video row whose destination belongs to another video", async () => {
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/other/copied-result";
		const objects = new Map<string, Buffer>([
			[resultKey, result],
			[privateCopy, Buffer.from(result)],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: createHash("sha256").update(result).digest("hex"),
			state: "COPIED",
		});
		await expect(
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
			}),
		).rejects.toThrow(/open relocation video mismatch/);
		expect(objects.has(resultKey)).toBe(true);
		expect(open.state).toBe("COPIED");
	});

	it("reconcileOnly still finishes an open copied result without a fresh liveKey", async () => {
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/video/reconcile-result";
		const liveKey = "private/source/video/kept";
		const original = Buffer.from("original-bytes");
		const originalSha = createHash("sha256").update(original).digest("hex");
		const objects = new Map<string, Buffer>([
			[resultKey, result],
			[privateCopy, Buffer.from(result)],
			[liveKey, original],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: "owner/video/source/original.mp4",
			newKey: liveKey,
			sha256: originalSha,
			state: "PURGED",
		});
		await journal.setLiveKey("video", liveKey, originalSha, "PURGED");
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: createHash("sha256").update(result).digest("hex"),
			state: "COPIED",
		});
		const proof = await relocateOwnerVideo({
			ownerId: "owner",
			videoId: "video",
			store,
			journal,
			reconcileOnly: true,
		});
		expect(open.state).toBe("PURGED");
		expect(open.newKey).toBe(privateCopy);
		expect(proof.liveKey).toBe(liveKey);
		expect(objects.has(resultKey)).toBe(false);
		expect(objects.get(privateCopy)?.equals(result)).toBe(true);
	});

	function sha(body: Buffer) {
		return createHash("sha256").update(body).digest("hex");
	}

	async function capture(run: () => Promise<unknown>) {
		try {
			return { error: undefined as unknown, value: await run() };
		} catch (error) {
			return { error, value: undefined };
		}
	}

	function trackKeyReads(store: ObjectStore) {
		const presignedKeys: string[] = [];
		const headKeys: string[] = [];
		const calls: Array<{
			url: string;
			method: string;
			range?: string;
			key?: string;
		}> = [];
		const signed = new Map<string, string>();
		const presignGet = store.presignGet.bind(store);
		const presignHead = store.presignHead?.bind(store);
		const request = store.request.bind(store);
		store.presignGet = async (key) => {
			presignedKeys.push(key);
			const url = await presignGet(key);
			signed.set(url, key);
			return url;
		};
		if (presignHead) {
			store.presignHead = async (key) => {
				headKeys.push(key);
				const url = await presignHead(key);
				signed.set(url, key);
				return url;
			};
		}
		store.request = async (url, method, range) => {
			calls.push({ url, method, range, key: signed.get(url) });
			return request(url, method, range);
		};
		return { presignedKeys, headKeys, calls };
	}

	function revealAfterPreflight(
		journal: ReturnType<typeof createMemoryJournal>,
		seed: () => Promise<void>,
	) {
		let reads = 0;
		let seeded = false;
		const first: string[] = [];
		const listOpen = journal.listOpen.bind(journal);
		journal.listOpen = async () => {
			reads += 1;
			if (reads === 1) {
				const rows = await listOpen();
				first.push(...rows.map((row) => `${row.videoId}:${row.oldKey}`));
				return rows;
			}
			if (!seeded) {
				seeded = true;
				await seed();
			}
			return listOpen();
		};
		return first;
	}

	it("does not purge a deleted row whose private copy hash does not match", async () => {
		const original = Buffer.from("original-bytes");
		const result = Buffer.from("protected-result");
		const wrong = Buffer.from("not-the-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/video/deleted-result";
		const originalKey = "owner/video/source/original.mp4";
		const pointer = "private/source/video/original";
		const originalSha = sha(original);
		const objects = new Map<string, Buffer>([
			[originalKey, original],
			[privateCopy, wrong],
			[pointer, Buffer.from(original)],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const source = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: originalKey,
			newKey: pointer,
			sha256: originalSha,
			state: "PURGED",
		});
		await journal.setLiveKey("video", pointer, originalSha, "PURGED");
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: sha(result),
			state: "DELETED",
		});
		const captured = await capture(() =>
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
				sourceKey: originalKey,
			}),
		);
		expect({
			state: open.state,
			privateUnchanged: objects.get(privateCopy)?.equals(wrong) === true,
			originalUnchanged: objects.get(originalKey)?.equals(original) === true,
			resultAbsent: objects.has(resultKey) === false,
			liveKey: await journal.getLiveKey("video"),
			liveSha: journal.live.get("video")?.sha256,
			sourceState: source.state,
			sourcePointer: source.newKey,
			sourceSha: source.sha256,
		}).toEqual({
			state: "DELETED",
			privateUnchanged: true,
			originalUnchanged: true,
			resultAbsent: true,
			liveKey: pointer,
			liveSha: originalSha,
			sourceState: "PURGED",
			sourcePointer: pointer,
			sourceSha: originalSha,
		});
		expect(captured.error).toBeInstanceOf(Error);
		expect((captured.error as Error).message).toMatch(/verified copy/);
	});

	it("does not purge a deleted row whose private copy is missing", async () => {
		const original = Buffer.from("original-bytes");
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/video/deleted-missing";
		const originalKey = "owner/video/source/original.mp4";
		const pointer = "private/source/video/original";
		const originalSha = sha(original);
		const objects = new Map<string, Buffer>([
			[originalKey, original],
			[pointer, Buffer.from(original)],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const source = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: originalKey,
			newKey: pointer,
			sha256: originalSha,
			state: "PURGED",
		});
		await journal.setLiveKey("video", pointer, originalSha, "PURGED");
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: sha(result),
			state: "DELETED",
		});
		const captured = await capture(() =>
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
				sourceKey: originalKey,
			}),
		);
		expect({
			state: open.state,
			privateAbsent: objects.has(privateCopy) === false,
			originalUnchanged: objects.get(originalKey)?.equals(original) === true,
			resultAbsent: objects.has(resultKey) === false,
			liveKey: await journal.getLiveKey("video"),
			liveSha: journal.live.get("video")?.sha256,
			sourceState: source.state,
			sourcePointer: source.newKey,
		}).toEqual({
			state: "DELETED",
			privateAbsent: true,
			originalUnchanged: true,
			resultAbsent: true,
			liveKey: pointer,
			liveSha: originalSha,
			sourceState: "PURGED",
			sourcePointer: pointer,
		});
		expect(captured.error).toBeInstanceOf(Error);
		expect((captured.error as Error).message).toMatch(/verified copy/);
	});

	async function absentDeletedProbe(sticky?: {
		get?: number;
		head?: number;
		range?: number;
	}) {
		const original = Buffer.from("original-bytes");
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/video/deleted-result";
		const originalKey = "owner/video/source/original.mp4";
		const objects = new Map<string, Buffer>([
			[originalKey, original],
			[privateCopy, Buffer.from(result)],
		]);
		const { store } = createProbeStore(objects);
		const tracked = trackKeyReads(store);
		const request = store.request.bind(store);
		store.request = async (url, method, range) => {
			const isResult =
				url === `https://minio.local/${resultKey}?get=1` ||
				url === `https://minio.local/${resultKey}?head=1`;
			if (isResult && sticky) {
				tracked.calls.push({ url, method, range, key: resultKey });
				if (range && sticky.range !== undefined) return sticky.range;
				if (method === "HEAD" && sticky.head !== undefined) return sticky.head;
				if (method === "GET" && !range && sticky.get !== undefined) {
					return sticky.get;
				}
			}
			return request(url, method, range);
		};
		const journal = createMemoryJournal();
		const presentAtStart = new Set(objects.keys());
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: sha(result),
			state: "DELETED",
		});
		const captured = await capture(() =>
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
				sourceKey: originalKey,
			}),
		);
		return { ...tracked, open, captured, resultKey, objects, presentAtStart };
	}

	it("probes a freshly minted equivalent url before purging an absent deleted key", async () => {
		const observed = await absentDeletedProbe();
		const mintedGet = `https://minio.local/${observed.resultKey}?get=1`;
		const mintedHead = `https://minio.local/${observed.resultKey}?head=1`;
		expect(
			observed.calls.filter(
				(call) => call.url === mintedGet || call.url === mintedHead,
			),
			"fresh equivalent key url is not a historical exact url",
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ url: mintedGet, method: "GET" }),
				expect.objectContaining({ url: mintedGet, method: "HEAD" }),
				expect.objectContaining({
					url: mintedGet,
					method: "GET",
					range: "bytes=0-0",
				}),
				expect.objectContaining({ url: mintedHead, method: "HEAD" }),
			]),
		);
		expect(Object.hasOwn(observed.open, "url")).toBe(false);
		expect(observed.presignedKeys).toContain(observed.resultKey);
		expect(observed.headKeys).toContain(observed.resultKey);
		expect(
			observed.presignedKeys.filter(
				(key) =>
					!observed.presentAtStart.has(key) && key !== observed.resultKey,
			),
		).toEqual([]);
		expect(observed.open.state).toBe("PURGED");
		expect(observed.captured.error).toBeUndefined();
	});

	it("does not purge an absent deleted key when the minted GET stays readable", async () => {
		const observed = await absentDeletedProbe({ get: 200 });
		expect(
			observed.calls.some(
				(call) =>
					call.key === observed.resultKey &&
					call.method === "GET" &&
					!call.range,
			),
		).toBe(true);
		expect(observed.open.state).not.toBe("PURGED");
		expect(observed.captured.error).toBeInstanceOf(Error);
		expect((observed.captured.error as Error).message).toMatch(
			/preissued url still readable/,
		);
	});

	it("does not purge an absent deleted key when the minted HEAD stays readable", async () => {
		const observed = await absentDeletedProbe({ head: 200 });
		expect(
			observed.calls.some(
				(call) => call.key === observed.resultKey && call.method === "HEAD",
			),
		).toBe(true);
		expect(observed.open.state).not.toBe("PURGED");
		expect((observed.captured.error as Error).message).toMatch(
			/preissued url still readable/,
		);
	});

	it("does not purge an absent deleted key when the minted range stays readable", async () => {
		const observed = await absentDeletedProbe({ range: 206 });
		expect(
			observed.calls.some(
				(call) => call.key === observed.resultKey && call.range === "bytes=0-0",
			),
		).toBe(true);
		expect(observed.open.state).not.toBe("PURGED");
		expect((observed.captured.error as Error).message).toMatch(
			/preissued url still readable/,
		);
	});

	it("does not replace a purged source pointer with a private-source result copy", async () => {
		const original = Buffer.from("original-bytes");
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const pointer = "private/source/video/original";
		const resultCopy = "private/source/video/result-copy";
		const sourceKey = "owner/video/source/original.mp4";
		const originalSha = sha(original);
		const resultSha = sha(result);
		const objects = new Map<string, Buffer>([
			[pointer, Buffer.from(original)],
			[resultKey, result],
			[resultCopy, Buffer.from(result)],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const source = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: sourceKey,
			newKey: pointer,
			sha256: originalSha,
			state: "PURGED",
		});
		await journal.setLiveKey("video", pointer, originalSha, "PURGED");
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: resultCopy,
			sha256: resultSha,
			state: "COPIED",
		});
		const proof = await relocateOwnerVideo({
			ownerId: "owner",
			videoId: "video",
			store,
			journal,
			sourceKey,
		});
		expect(proof.liveKey).toBe(pointer);
		expect(journal.live.get("video")?.sha256).toBe(originalSha);
		expect(source.state).toBe("PURGED");
		expect(source.newKey).toBe(pointer);
		expect(source.sha256).toBe(originalSha);
		expect(source.oldKey).toBe(sourceKey);
		expect(open.state).toBe("PURGED");
		expect(open.newKey).toBe(resultCopy);
		expect(objects.has(resultKey)).toBe(false);
		expect(objects.get(resultCopy)?.equals(result)).toBe(true);
		expect(objects.has(sourceKey)).toBe(false);
	});

	it("completes a deleted private-source result when the public original is already absent", async () => {
		const original = Buffer.from("original-bytes");
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const pointer = "private/source/video/original";
		const resultCopy = "private/source/video/result-copy";
		const sourceKey = "owner/video/source/original.mp4";
		const originalSha = sha(original);
		const objects = new Map<string, Buffer>([
			[pointer, Buffer.from(original)],
			[resultCopy, Buffer.from(result)],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const source = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: sourceKey,
			newKey: pointer,
			sha256: originalSha,
			state: "PURGED",
		});
		await journal.setLiveKey("video", pointer, originalSha, "PURGED");
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: resultCopy,
			sha256: sha(result),
			state: "DELETED",
		});
		const proof = await relocateOwnerVideo({
			ownerId: "owner",
			videoId: "video",
			store,
			journal,
			sourceKey,
		});
		expect(proof.liveKey).toBe(pointer);
		expect(journal.live.get("video")?.sha256).toBe(originalSha);
		expect(source.newKey).toBe(pointer);
		expect(source.sha256).toBe(originalSha);
		expect(source.state).toBe("PURGED");
		expect(open.state).toBe("PURGED");
		expect(open.newKey).toBe(resultCopy);
		expect(objects.has(sourceKey)).toBe(false);
		expect(objects.has(resultKey)).toBe(false);
	});

	it("still promotes a copied private-source result when no purged source exists", async () => {
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/source/video/promoted-result";
		const sourceKey = "owner/video/source/original.mp4";
		const objects = new Map<string, Buffer>([
			[resultKey, result],
			[privateCopy, Buffer.from(result)],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		const open = await journal.insertIntent({
			videoId: "video",
			revisionId: "relocate",
			oldKey: resultKey,
			newKey: privateCopy,
			sha256: sha(result),
			state: "COPIED",
		});
		const proof = await relocateOwnerVideo({
			ownerId: "owner",
			videoId: "video",
			store,
			journal,
			sourceKey,
		});
		expect(open.state).toBe("PURGED");
		expect(open.newKey).toBe(privateCopy);
		expect(proof.liveKey).toBe(privateCopy);
		expect(proof.liveKey?.startsWith("private/source/video/")).toBe(true);
		expect(objects.has(resultKey)).toBe(false);
		expect(objects.has(sourceKey)).toBe(false);
	});

	it("does not resume a cross-video result inserted after the preflight read", async () => {
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/other/copy";
		const originalKey = "owner/video/source/original.mp4";
		const objects = new Map<string, Buffer>([
			[originalKey, Buffer.from("original-bytes")],
			[resultKey, result],
			[privateCopy, Buffer.from(result)],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		let open: Awaited<ReturnType<typeof journal.insertIntent>> | undefined;
		const first = revealAfterPreflight(journal, async () => {
			open = await journal.insertIntent({
				videoId: "other",
				revisionId: "relocate",
				oldKey: resultKey,
				newKey: privateCopy,
				sha256: sha(result),
				state: "COPIED",
			});
		});
		const captured = await capture(() =>
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
				sourceKey: originalKey,
			}),
		);
		expect({
			resultRemains: objects.has(resultKey),
			originalRemains: objects.has(originalKey),
			copyRemains: objects.get(privateCopy)?.equals(result) === true,
			rowState: open?.state,
			liveKey: await journal.getLiveKey("video"),
			otherLiveKey: await journal.getLiveKey("other"),
			firstReadSawForeign: first.some((item) => item.startsWith("other:")),
		}).toEqual({
			resultRemains: true,
			originalRemains: true,
			copyRemains: true,
			rowState: "COPIED",
			liveKey: null,
			otherLiveKey: null,
			firstReadSawForeign: false,
		});
		expect((captured.error as Error).message).toMatch(
			/open relocation video mismatch/,
		);
	});

	it("does not resume an invalid destination inserted after the preflight read", async () => {
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const privateCopy = "private/rollback/other/copy";
		const originalKey = "owner/video/source/original.mp4";
		const objects = new Map<string, Buffer>([
			[originalKey, Buffer.from("original-bytes")],
			[resultKey, result],
			[privateCopy, Buffer.from(result)],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		let open: Awaited<ReturnType<typeof journal.insertIntent>> | undefined;
		revealAfterPreflight(journal, async () => {
			open = await journal.insertIntent({
				videoId: "video",
				revisionId: "relocate",
				oldKey: resultKey,
				newKey: privateCopy,
				sha256: sha(result),
				state: "COPIED",
			});
		});
		const captured = await capture(() =>
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
				sourceKey: originalKey,
			}),
		);
		expect({
			resultRemains: objects.has(resultKey),
			originalRemains: objects.has(originalKey),
			rowState: open?.state,
			liveKey: await journal.getLiveKey("video"),
		}).toEqual({
			resultRemains: true,
			originalRemains: true,
			rowState: "COPIED",
			liveKey: null,
		});
		expect((captured.error as Error).message).toMatch(
			/open relocation video mismatch/,
		);
	});

	it("does not mutate when ambiguous rows appear after the preflight read", async () => {
		const result = Buffer.from("protected-result");
		const resultKey = "owner/video/result.mp4";
		const originalKey = "owner/video/source/original.mp4";
		const objects = new Map<string, Buffer>([
			[originalKey, Buffer.from("original-bytes")],
			[resultKey, result],
			["private/rollback/video/first", Buffer.from(result)],
			["private/rollback/video/second", Buffer.from(result)],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		let first: Awaited<ReturnType<typeof journal.insertIntent>> | undefined;
		let second: Awaited<ReturnType<typeof journal.insertIntent>> | undefined;
		revealAfterPreflight(journal, async () => {
			first = await journal.insertIntent({
				videoId: "video",
				revisionId: "relocate",
				oldKey: resultKey,
				newKey: "private/rollback/video/first",
				sha256: sha(result),
				state: "COPIED",
			});
			second = await journal.insertIntent({
				videoId: "video",
				revisionId: "relocate",
				oldKey: resultKey,
				newKey: "private/rollback/video/second",
				sha256: sha(result),
				state: "COPIED",
			});
		});
		const captured = await capture(() =>
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
				sourceKey: originalKey,
			}),
		);
		expect({
			originalRemains: objects.has(originalKey),
			resultRemains: objects.has(resultKey),
			firstState: first?.state,
			secondState: second?.state,
			liveKey: await journal.getLiveKey("video"),
		}).toEqual({
			originalRemains: true,
			resultRemains: true,
			firstState: "COPIED",
			secondState: "COPIED",
			liveKey: null,
		});
		expect((captured.error as Error).message).toMatch(
			/ambiguous open relocation/,
		);
	});

	it("does not mutate when a competing pointer row appears after the preflight read", async () => {
		const result = Buffer.from("protected-result");
		const original = Buffer.from("original-bytes");
		const resultKey = "owner/video/result.mp4";
		const originalKey = "owner/video/source/original.mp4";
		const privateCopy = "private/source/video/competitor";
		const objects = new Map<string, Buffer>([
			[originalKey, original],
			[resultKey, result],
			[privateCopy, Buffer.from(result)],
		]);
		const { store } = createProbeStore(objects);
		const journal = createMemoryJournal();
		let open: Awaited<ReturnType<typeof journal.insertIntent>> | undefined;
		revealAfterPreflight(journal, async () => {
			open = await journal.insertIntent({
				videoId: "video",
				revisionId: "relocate",
				oldKey: resultKey,
				newKey: privateCopy,
				sha256: sha(result),
				state: "COPIED",
			});
		});
		const captured = await capture(() =>
			relocateOwnerVideo({
				ownerId: "owner",
				videoId: "video",
				store,
				journal,
				sourceKey: originalKey,
			}),
		);
		expect({
			originalRemains: objects.has(originalKey),
			resultRemains: objects.has(resultKey),
			copyRemains: objects.get(privateCopy)?.equals(result) === true,
			rowState: open?.state,
			liveKey: await journal.getLiveKey("video"),
		}).toEqual({
			originalRemains: true,
			resultRemains: true,
			copyRemains: true,
			rowState: "COPIED",
			liveKey: null,
		});
		expect((captured.error as Error).message).toMatch(
			/multiple original relocations would change liveKey/,
		);
	});
});

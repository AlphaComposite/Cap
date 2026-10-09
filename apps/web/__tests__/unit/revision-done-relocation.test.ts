import { afterEach, expect, it, vi } from "vitest";
import { publishDoneWithRetry } from "@/lib/revision-done";
import { RevisionPublicationError } from "@/lib/revision-publication-metadata";
import {
	assertFinishInventoryClear,
	assertFinishSourceKey,
	createMemoryJournal,
	type ObjectStore,
	relocateOwnerVideo,
} from "@/lib/source-relocation";

const refusal =
	"Finish refused until source relocation is PURGED and liveKey is the relocated key";

afterEach(() => vi.useRealTimers());

it("Done waits for a slow rollback copy, then passes the unchanged prepare gates", async () => {
	vi.useFakeTimers();
	const prefix = "owner/video/";
	const liveKey = "private/source/video/original";
	const oldKey = `${prefix}screenshot/screen-capture.jpg`;
	const objects = new Set([liveKey, oldKey]);
	const journal = createMemoryJournal();
	await journal.insertIntent({
		videoId: "video",
		revisionId: "original",
		oldKey: `${prefix}result.mp4`,
		newKey: liveKey,
		sha256: "a".repeat(64),
		state: "PURGED",
	});
	await journal.setLiveKey("video", liveKey, "a".repeat(64), "PURGED");
	const store: ObjectStore = {
		copy: async (_, key) => {
			await new Promise((resolve) => setTimeout(resolve, 6_000));
			objects.add(key);
		},
		sha256: async (key) => (objects.has(key) ? "a".repeat(64) : null),
		deleteAllVersions: async (key) => {
			objects.delete(key);
		},
		exists: async (key) => objects.has(key),
		presignGet: async (key) => key,
		list: async (p) => [...objects].filter((key) => key.startsWith(p)),
		request: async (key) => (objects.has(key) ? 200 : 404),
	};
	const relocation = relocateOwnerVideo({
		ownerId: "owner",
		videoId: "video",
		sourceKey: liveKey,
		store,
		journal,
	});
	const publish = vi.fn(async () => {
		assertFinishSourceKey({ liveKey, relocations: journal.rows });
		if (journal.rows.some((row) => row.state !== "PURGED"))
			throw new RevisionPublicationError(409, refusal);
		assertFinishInventoryClear(await store.list?.(prefix), prefix);
		return "published";
	});
	const refresh = vi.fn();
	const waiting = vi.fn();
	const done = publishDoneWithRetry(publish, refresh, waiting).then(
		(value) => ({ value, error: null }),
		(error) => ({ value: null, error }),
	);
	await vi.advanceTimersByTimeAsync(7_000);
	expect(await done).toEqual({ value: "published", error: null });
	await relocation;
	expect(publish.mock.calls.length).toBeGreaterThan(2);
	expect(refresh).not.toHaveBeenCalled();
	expect(waiting).toHaveBeenCalled();
	expect(journal.rows.every((row) => row.state === "PURGED")).toBe(true);
});

it("stops at 60 seconds and still refuses a genuinely unrelocated source", async () => {
	vi.useFakeTimers();
	const started = performance.now();
	let signal: AbortSignal | undefined;
	const publish = vi.fn(async (requestSignal?: AbortSignal) => {
		signal = requestSignal;
		try {
			assertFinishSourceKey({
				liveKey: "owner/video/result.mp4",
				relocations: [],
			});
		} catch {
			throw new RevisionPublicationError(409, refusal);
		}
	});
	let settled = false;
	const done = publishDoneWithRetry(publish, vi.fn()).catch((error) => {
		settled = true;
		return error;
	});
	await vi.advanceTimersByTimeAsync(59_000);
	expect(settled).toBe(false);
	await vi.advanceTimersByTimeAsync(1_000);
	expect((await done).message).toBe(refusal);
	expect(performance.now() - started).toBe(60_000);
	expect(signal?.aborted).toBe(true);
});

it("aborts an in-flight publish at the same deadline", async () => {
	vi.useFakeTimers();
	const publish = vi.fn(
		(signal: AbortSignal) =>
			new Promise<never>((_, reject) => {
				signal.addEventListener("abort", () => reject(new Error("deadline")), {
					once: true,
				});
			}),
	);
	const done = publishDoneWithRetry(publish, vi.fn()).catch((error) => error);
	await vi.advanceTimersByTimeAsync(60_000);
	expect((await done).message).toBe("deadline");
	expect(publish).toHaveBeenCalledOnce();
});

it("keeps one refresh retry for unrelated 409s and never retries a 500", async () => {
	const conflict = new RevisionPublicationError(409, "another editor");
	const publish = vi.fn().mockRejectedValue(conflict);
	const refresh = vi.fn();
	await expect(publishDoneWithRetry(publish, refresh)).rejects.toBe(conflict);
	expect(publish).toHaveBeenCalledTimes(2);
	expect(refresh).toHaveBeenCalledOnce();
	const failure = new RevisionPublicationError(500, refusal);
	const failed = vi.fn().mockRejectedValue(failure);
	await expect(publishDoneWithRetry(failed, refresh)).rejects.toBe(failure);
	expect(failed).toHaveBeenCalledOnce();
});

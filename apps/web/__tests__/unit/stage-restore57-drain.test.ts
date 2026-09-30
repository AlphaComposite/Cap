import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const secret = "db claim failed token=lease-secret";

function claimDb(mode: "claim" | "load") {
	const row = {
		id: 7,
		job: "source-prepare",
		payload: {
			videoId: "video-drain",
			ownerId: "owner-drain",
			sourceObjectKey: "owner-drain/video-drain/result.mp4",
			attempts: 0,
			notBeforeMs: 0,
		},
	};
	let selects = 0;
	const query = (rows: unknown[]) => {
		const result = Promise.resolve(rows);
		return Object.assign(result, {
			from: () => query(rows),
			where: () => query(rows),
			orderBy: () => query(rows),
			limit: () => query(rows),
			for: async () => rows,
			set: () => ({ where: async () => undefined }),
		});
	};
	const db = {
		select() {
			selects += 1;
			if (mode === "claim" || (mode === "load" && selects > 1)) {
				throw new Error(secret);
			}
			return query([row]);
		},
		update: () => ({ set: () => ({ where: async () => undefined }) }),
		delete: () => ({ where: async () => undefined }),
		transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
	};
	return db;
}

describe("source-prepare drain errors", () => {
	const logs: string[] = [];
	beforeEach(() => {
		logs.length = 0;
		vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
			logs.push(String(message));
		});
	});

	it.each(["claim", "load"] as const)(
		"rejects a %s database error without logging the query",
		async (mode) => {
			const { drainSourcePrepare } = await import(
				"@/lib/source-prepare-worker"
			);
			await expect(
				drainSourcePrepare(claimDb(mode), { fetchArtifact: vi.fn() }),
			).rejects.toThrow(secret);
			expect(logs).toEqual(["source-prepare drain failed"]);
			expect(logs.join("\n")).not.toContain("token=");
			expect(logs.join("\n")).not.toContain(secret);
		},
	);
});

import { getTableName, type Table } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({ db: () => ({}) }));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}), buildEnv: {} }));
vi.mock("@/lib/revision-media-grant", () => ({
	readArtifactReady: async () => false,
}));
vi.mock("@/lib/instant-finish-source-relocate", () => ({
	runtimeS3Client: () => {
		throw new Error("No storage configured");
	},
}));

import { drainRevisionDownloads as sweepRevisionDownloads } from "@/lib/revision-download-job";
import { httpOriginClient } from "@/lib/revision-publication-origin";

function database() {
	const writes: Record<string, unknown>[] = [];
	const payload = {
		job: "download",
		videoId: "video1234",
		revisionId: "revision1234",
	};
	let claimed = false;
	const app = {
		select() {
			let table = "";
			const run = () => {
				if (table === "video_publication")
					return [
						{ currentRevisionId: payload.revisionId, currentGeneration: 1 },
					];
				if (table === "edit_revision")
					return [
						{
							...payload,
							generation: 1,
							sourceId: "source1234",
							state: "CURRENT",
							ownerId: "owner1234",
							metadataSnapshot: {},
						},
					];
				if (table === "outbox") return [{ id: 1, payload }];
				return [];
			};
			const chain = Object.assign(Promise.resolve().then(run), {
				from(value: Table) {
					table = getTableName(value);
					return chain;
				},
				where() {
					return chain;
				},
				innerJoin() {
					return chain;
				},
				orderBy() {
					return chain;
				},
				limit() {
					return chain;
				},
				for() {
					if (claimed) return Promise.resolve([]);
					claimed = true;
					return Promise.resolve(run());
				},
			});
			return chain;
		},
		update() {
			return {
				set(value: Record<string, unknown>) {
					writes.push(value);
					if (value.payload) Object.assign(payload, value.payload);
					return { where: async () => undefined };
				},
			};
		},
		delete() {
			return { where: async () => undefined };
		},
		transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> =>
			run(app),
	};
	return { app, writes };
}

describe("durable export baseline", () => {
	it("does not turn an origin POST 200 into durable READY without upload/readback", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { app, writes } = database();
		await sweepRevisionDownloads(app, {
			origin: {
				prepareRevision: vi.fn(),
				selectFrames: vi.fn(),
				fetchArtifact: vi.fn(),
				requestDownload: async () => ({ status: 200 }),
			},
			limit: 1,
		});
		expect(writes.some((value) => value.state === "READY")).toBe(false);
	});
	it("provides a streaming finalized-download transport instead of buffered fetchArtifact", () => {
		expect(httpOriginClient()).toHaveProperty(
			"streamDownload",
			expect.any(Function),
		);
	});
});

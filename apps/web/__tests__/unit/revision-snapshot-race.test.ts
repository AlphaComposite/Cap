import type { db } from "@cap/database";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import { writeRevisionThumbnailSha } from "@/lib/revision-snapshot-patch";

type Snapshot = {
	chapters: { title: string; start: number }[];
	thumbnailSha256?: string;
	downloadReady?: boolean;
};

const dialect = new MySqlDialect();

function applySnapshotWrite(current: Snapshot, value: unknown): Snapshot {
	if (value && typeof value === "object" && "queryChunks" in value) {
		const query = dialect.sqlToQuery(
			value as Parameters<MySqlDialect["sqlToQuery"]>[0],
		);
		if (!query.sql.includes("JSON_SET")) return value as unknown as Snapshot;
		const next = { ...current };
		if (query.sql.includes("$.downloadReady")) next.downloadReady = true;
		if (query.sql.includes("$.thumbnailSha256")) {
			const raw = query.params[query.params.length - 1];
			next.thumbnailSha256 =
				typeof raw === "string" ? (JSON.parse(raw) as string) : String(raw);
		}
		return next;
	}
	return value as Snapshot;
}

describe("thumbnail snapshot race", () => {
	it("keeps downloadReady when a stale thumbnail write lands after it", async () => {
		const stale: Snapshot = {
			chapters: [{ title: "Intro", start: 0 }],
			thumbnailSha256: "pending",
		};
		let live: Snapshot = { ...stale, chapters: [...stale.chapters] };
		let serveStale = false;
		const database = {
			select: () => ({
				from: () => ({
					where: async () => [
						{
							metadataSnapshot: structuredClone(serveStale ? stale : live),
						},
					],
				}),
			}),
			update: () => ({
				set: (values: { metadataSnapshot?: unknown }) => ({
					where: async () => {
						if (!values.metadataSnapshot) return;
						live = applySnapshotWrite(live, values.metadataSnapshot);
					},
				}),
			}),
		};
		live = { ...live, downloadReady: true };
		serveStale = true;
		await writeRevisionThumbnailSha(
			database as unknown as ReturnType<typeof db>,
			"rev",
			"digest-ready",
		);
		expect(live.downloadReady).toBe(true);
		expect(live.thumbnailSha256).toBe("digest-ready");
		expect(live.chapters).toEqual(stale.chapters);
	});
});

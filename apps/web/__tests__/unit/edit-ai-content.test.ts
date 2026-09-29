import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getCurrentUser: vi.fn(),
	transaction: vi.fn(),
	revalidatePath: vi.fn(),
	entitled: vi.fn(),
	lockedRead: vi.fn(),
	write: vi.fn(),
}));
vi.mock("@cap/database", () => ({
	db: () => ({ transaction: mocks.transaction }),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: mocks.entitled,
}));

import type { Video } from "@cap/web-domain";
import { sql } from "drizzle-orm";
import { editAiContent } from "@/actions/videos/edit-ai-content";
import { setGeneratedAiContent } from "@/lib/ai-content-metadata";
import { INSTANT_FINISH_OWNER_ENV } from "@/lib/instant-finish-flag";
import {
	mergeOwnerChapterEdit,
	projectSourceChapters,
} from "@/lib/revision-chapter-source";
import { createIdentityEditSpec } from "@/lib/video-edits";

const videoId = "video-id" as Video.VideoId;
const expected = {
	summary: "Original",
	chapters: [{ title: "Intro", start: 0 }],
};
let readSql: string;
let writeSql: string;
let writeParams: unknown[];
let metadata: Record<string, unknown>;
let revisionRows: unknown[] = [];

beforeEach(() => {
	metadata = {
		...expected,
		aiGenerationStatus: "COMPLETE",
		customCreatedAt: "2026-01-01",
	};
	revisionRows = [];
	mocks.getCurrentUser.mockResolvedValue({ id: "owner" });
	mocks.entitled.mockReturnValue(true);
	mocks.lockedRead.mockImplementation(async () => [
		{ metadata, duration: 120 },
	]);
	mocks.write.mockResolvedValue([{ affectedRows: 1 }]);
	const dialect = new MySqlDialect();
	const tx = {
		select: () => ({
			from: () => ({
				where: (condition: Parameters<MySqlDialect["sqlToQuery"]>[0]) => {
					readSql = JSON.stringify(dialect.sqlToQuery(condition));
					return { for: mocks.lockedRead };
				},
				innerJoin: () => ({
					innerJoin: () => ({
						where: () => revisionRows,
					}),
				}),
			}),
		}),
		update: () => ({
			set: (values: {
				metadata: Parameters<MySqlDialect["sqlToQuery"]>[0];
			}) => {
				const query = dialect.sqlToQuery(values.metadata);
				writeSql = query.sql;
				writeParams = query.params;
				return { where: mocks.write };
			},
		}),
	};
	mocks.transaction.mockImplementation((callback) => callback(tx));
});

describe("editing AI content", () => {
	it("does not treat existing surrounding whitespace as a manual edit", async () => {
		const original = {
			summary: " Original ",
			chapters: [{ title: " Intro ", start: 0 }],
		};
		metadata = { ...original, aiGenerationStatus: "COMPLETE" };
		expect(
			await editAiContent(videoId, { expected: original, value: original }),
		).toEqual({ success: true, data: original });
		expect(mocks.write).not.toHaveBeenCalled();
		await editAiContent(videoId, {
			expected: original,
			value: { ...original, summary: "Changed" },
		});
		expect(writeSql).not.toContain("chaptersManuallyEdited");
	});
	it("compares chapters independently of MySQL JSON key ordering", async () => {
		metadata.chapters = [{ start: 0, title: "Intro" }];
		expect(
			(
				await editAiContent(videoId, {
					expected,
					value: { ...expected, chapters: [{ title: "Renamed", start: 0 }] },
				})
			).success,
		).toBe(true);
	});
	it("blocks edits during transcription after a media change", async () => {
		mocks.lockedRead.mockResolvedValueOnce([
			{ metadata, duration: 120, transcriptionStatus: "PROCESSING" },
		]);
		expect(
			(
				await editAiContent(videoId, {
					expected,
					value: { ...expected, summary: "Edited" },
				})
			).success,
		).toBe(false);
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("requires authentication and Pro entitlement", async () => {
		mocks.getCurrentUser.mockResolvedValueOnce(null);
		expect((await editAiContent(videoId, {})).success).toBe(false);
		mocks.entitled.mockReturnValueOnce(false);
		expect((await editAiContent(videoId, {})).success).toBe(false);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});
	it("scopes the locked row to its owner", async () => {
		mocks.lockedRead.mockResolvedValueOnce([]);
		expect(
			(
				await editAiContent(videoId, {
					expected,
					value: { ...expected, summary: "Edited" },
				})
			).success,
		).toBe(false);
		expect(readSql).toContain("ownerId");
		expect(readSql).toContain("owner");
		expect(mocks.lockedRead).toHaveBeenCalledWith("update");
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("updates only the summary while retaining concurrently updated chapters", async () => {
		metadata.chapters = [{ title: "Updated elsewhere", start: 10 }];
		const result = await editAiContent(videoId, {
			expected,
			value: { ...expected, summary: "  **Edited**  " },
		});
		expect(result).toEqual({
			success: true,
			data: { summary: "**Edited**", chapters: metadata.chapters },
		});
		expect(writeSql).toContain("JSON_SET");
		expect(writeSql).toContain("summaryManuallyEdited");
		expect(writeSql).not.toContain("chaptersManuallyEdited");
		expect(writeParams).toContain("**Edited**");
		expect(mocks.revalidatePath).toHaveBeenCalledWith("/s/video-id");
	});
	it("updates chapters as JSON and preserves a concurrent summary edit", async () => {
		metadata.summary = "Updated elsewhere";
		const result = await editAiContent(videoId, {
			expected,
			value: { ...expected, chapters: [{ title: "  Changed  ", start: 20 }] },
		});
		expect(result).toEqual({
			success: true,
			data: {
				summary: "Updated elsewhere",
				chapters: [{ title: "Changed", start: 20 }],
			},
		});
		expect(writeSql).toContain("CAST(? AS JSON)");
		expect(writeSql).toContain("JSON_REMOVE");
		expect(writeSql).toContain("$.aiChapterBackfillGenerationId");
		expect(writeSql).not.toContain("summaryManuallyEdited");
		expect(writeParams).toContain('[{"title":"Changed","start":20}]');
	});

	it("drops a stale source chapter list when chapters change with the flag off", async () => {
		const result = await editAiContent(videoId, {
			expected,
			value: { ...expected, chapters: [{ title: "Flag off", start: 20 }] },
		});
		expect(result.success).toBe(true);
		expect(writeSql).toContain("'$.sourceChapters'");
	});
	it("rejects stale edits without writing", async () => {
		metadata.summary = "Newer saved summary";
		const result = await editAiContent(videoId, {
			expected,
			value: { ...expected, summary: "Stale edit" },
		});
		expect(result).toMatchObject({
			success: false,
			message: expect.stringContaining("changed since"),
		});
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it.each(["QUEUED", "PROCESSING"])(
		"allows summary-only edits while %s",
		async (status) => {
			metadata.aiGenerationStatus = status;
			const result = await editAiContent(videoId, {
				expected,
				value: { ...expected, summary: "Edited while chapters generate" },
			});
			expect(result).toEqual({
				success: true,
				data: { ...expected, summary: "Edited while chapters generate" },
			});
			expect(writeSql).toContain("summaryManuallyEdited");
		},
	);
	it.each(["QUEUED", "PROCESSING"])(
		"rejects chapter edits while %s with chapter-generation copy",
		async (status) => {
			metadata.aiGenerationStatus = status;
			const result = await editAiContent(videoId, {
				expected,
				value: {
					...expected,
					chapters: [{ title: "Edited chapter", start: 10 }],
				},
			});

			expect(result).toEqual({
				success: false,
				message:
					"Wait for chapter generation to finish before editing chapters.",
			});
			expect(mocks.write).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ summary: 123, chapters: [] },
		{ summary: "x", chapters: [{ title: "Bad", start: Number.NaN }] },
		{ summary: "x", chapters: [{ title: "Bad", start: 120 }] },
		{ summary: "x", chapters: [{ title: "", start: 0 }] },
		{
			summary: "x",
			chapters: [
				{ title: "A", start: 10 },
				{ title: "B", start: 10 },
			],
		},
	])("rejects malformed or invalid content", async (value) => {
		expect((await editAiContent(videoId, { expected, value })).success).toBe(
			false,
		);
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("allows deliberate removal and avoids writing unchanged data", async () => {
		expect(
			(await editAiContent(videoId, { expected, value: expected })).success,
		).toBe(true);
		expect(mocks.write).not.toHaveBeenCalled();
		expect(
			await editAiContent(videoId, {
				expected,
				value: { summary: "", chapters: [] },
			}),
		).toEqual({ success: true, data: { summary: "", chapters: [] } });
		expect(writeSql).toContain("summaryManuallyEdited");
		expect(writeSql).toContain("chaptersManuallyEdited");
		expect(writeSql).toContain("JSON_REMOVE");
		expect(writeSql).toContain("$.aiChapterBackfillGenerationId");
	});
	it("reports storage failures without pretending the draft was saved", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.write.mockRejectedValueOnce(new Error("database unavailable"));
		expect(
			(
				await editAiContent(videoId, {
					expected,
					value: { ...expected, summary: "Edited" },
				})
			).success,
		).toBe(false);
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});
});

describe("owner chapter rules on a revision", () => {
	const spec = createIdentityEditSpec(100);

	async function asRevisionOwner(
		source: { title: string; start: number }[],
		visible: { title: string; start: number }[],
		run: () => Promise<void>,
		durationSeconds = 100,
	) {
		const previousOwners = process.env[INSTANT_FINISH_OWNER_ENV];
		process.env[INSTANT_FINISH_OWNER_ENV] = "owner";
		metadata = {
			summary: "Original",
			chapters: visible,
			sourceChapters: source,
			chaptersRevisionId: "rev-1",
			aiGenerationStatus: "COMPLETE",
		};
		revisionRows = [
			{
				revisionId: "rev-1",
				metadataSnapshot: {
					durationSeconds,
					chapters: visible,
					captionsVtt: "",
					summaryStatus: "persisted",
					summaryDerived: false,
					summaryText: null,
					thumbnail: "unavailable",
				},
				canonicalSpec: spec,
			},
		];
		mocks.lockedRead.mockResolvedValue([
			{
				metadata,
				duration: 120,
				ownerId: "owner",
				transcriptionStatus: "COMPLETE",
			},
		]);
		try {
			await run();
		} finally {
			if (previousOwners === undefined) {
				delete process.env[INSTANT_FINISH_OWNER_ENV];
			} else {
				process.env[INSTANT_FINISH_OWNER_ENV] = previousOwners;
			}
		}
	}

	it("measures the last chapter against the revision the viewer sees, not the source duration", async () => {
		const source = [
			{ title: "A", start: 0 },
			{ title: "Late", start: 35 },
		];
		const visible = projectSourceChapters(source, spec);
		await asRevisionOwner(
			source,
			visible,
			async () => {
				const result = await editAiContent(videoId, {
					expected: { summary: "Original", chapters: visible },
					value: {
						summary: "Original",
						chapters: [
							{ title: "A", start: 0 },
							{ title: "Late", start: 35 },
						],
					},
				});
				expect(result).toEqual({
					success: false,
					message: "Chapter 2 must be at least 10 seconds long.",
				});
				expect(mocks.write).not.toHaveBeenCalled();
			},
			40,
		);
	});

	it("refuses a chapter shorter than 10 seconds and saves nothing", async () => {
		const source = [
			{ title: "A", start: 0 },
			{ title: "HiddenB", start: 30 },
			{ title: "C", start: 35 },
		];
		const visible = projectSourceChapters(source, spec);
		await asRevisionOwner(source, visible, async () => {
			const result = await editAiContent(videoId, {
				expected: { summary: "Original", chapters: visible },
				value: {
					summary: "Original",
					chapters: [
						{ title: "A", start: 0 },
						{ title: "C", start: 30 },
						{ title: "D", start: 35 },
					],
				},
			});
			expect(result).toEqual({
				success: false,
				message: "Chapter 2 must be at least 10 seconds long.",
			});
			expect(mocks.write).not.toHaveBeenCalled();
		});
	});

	it("rejects a projection mismatch and saves nothing", async () => {
		const source = [
			{ title: "HiddenBeacon", start: 0 },
			{ title: "HiddenTwo", start: 4 },
			{ title: "Kept", start: 9 },
			{ title: "Moved", start: 20 },
		];
		const visible = projectSourceChapters(source, spec);
		const submitted = visible.map((chapter, index) =>
			index === visible.length - 1
				? { ...chapter, start: chapter.start - 5 }
				: chapter,
		);
		expect(
			projectSourceChapters(
				mergeOwnerChapterEdit({
					previousSourceChapters: source,
					currentSpec: spec,
					editedChapters: submitted,
				}),
				spec,
			),
		).not.toEqual(submitted);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await asRevisionOwner(source, visible, async () => {
				const result = await editAiContent(videoId, {
					expected: { summary: "Original", chapters: visible },
					value: { summary: "Original", chapters: submitted },
				});
				expect(result).toEqual({
					success: false,
					message:
						"Couldn't save chapters. Please check the times and try again.",
				});
				expect(mocks.write).not.toHaveBeenCalled();
				const logged = errorSpy.mock.calls.flat().join(" ");
				expect(logged).toContain("OwnerChapterProjectionMismatch");
				expect(logged).not.toContain("HiddenBeacon");
				expect(logged).not.toContain("Kept");
				expect(logged).not.toContain("Moved");
			});
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("saves an empty owner list without restoring hidden chapters", async () => {
		const source = [
			{ title: "A", start: 0 },
			{ title: "HiddenB", start: 30 },
			{ title: "C", start: 35 },
		];
		const visible = projectSourceChapters(source, spec);
		await asRevisionOwner(source, visible, async () => {
			const result = await editAiContent(videoId, {
				expected: { summary: "Original", chapters: visible },
				value: { summary: "Original", chapters: [] },
			});
			expect(result).toEqual({
				success: true,
				data: { summary: "Original", chapters: [] },
			});
			expect(writeParams).toContain("[]");
			expect(JSON.stringify(writeParams)).not.toContain("HiddenB");
		});
	});
});

describe("generation preserves manual content", () => {
	it("rejects generated summary metadata instead of offering a summary write path", () => {
		expect(() =>
			setGeneratedAiContent(
				sql`JSON_OBJECT()`,
				"summary" as never,
				"Generated" as never,
			),
		).toThrow("Generated AI content only supports chapters");
	});

	it("never overwrites manually edited chapters even when the content key is absent", () => {
		const query = new MySqlDialect().sqlToQuery(
			setGeneratedAiContent(sql`JSON_OBJECT()`, "chapters", []),
		);
		expect(query.sql).not.toContain("JSON_CONTAINS_PATH");
		expect(query.sql).toContain("IF(");
		expect(query.params).toContain("$.chaptersManuallyEdited");
		expect(
			query.params.filter((parameter) => parameter === "$.chapters"),
		).toHaveLength(1);
		expect(query.sql).toContain("CAST('false' AS JSON)");
	});
});

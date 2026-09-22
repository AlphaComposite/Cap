import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { executeAutomaticChapterBackfillCli } from "@/lib/automatic-chapter-backfill-cli";

const privateRow = {
	id: "video-1",
	ownerId: "private-owner",
	duration: 120,
	transcriptionStatus: "COMPLETE",
	updatedAt: new Date("2026-07-20T15:00:00.000Z"),
	metadata: {
		summary: "private summary",
		transcript: "private transcript",
	},
};

describe("automatic chapter backfill CLI", () => {
	it("executes a privacy-safe dry run by default", async () => {
		const write = vi.fn();
		const startGeneration = vi.fn();

		const count = await executeAutomaticChapterBackfillCli(
			[],
			{
				listVideos: vi.fn().mockResolvedValue([privateRow]),
				startGeneration,
			},
			write,
		);

		expect(count).toBe(1);
		expect(startGeneration).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalledOnce();
		const line = write.mock.calls[0]?.[0] as string;
		expect(JSON.parse(line)).toEqual({
			videoId: "video-1",
			duration: 120,
			currentChapterCount: 0,
			reason: "chapters-missing",
			status: "would-start",
		});
		expect(line).not.toMatch(
			/private summary|private transcript|private-owner/,
		);
	});

	it("is wired as an executable package command", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../../package.json", import.meta.url), "utf8"),
		) as { scripts?: Record<string, string> };
		const command = packageJson.scripts?.["backfill:automatic-chapters"];
		expect(command).toContain("scripts/backfill-automatic-chapters.ts");
		const script = await readFile(
			new URL("../../scripts/backfill-automatic-chapters.ts", import.meta.url),
			"utf8",
		);
		expect(script).toContain("executeAutomaticChapterBackfillCli");
		expect(script).toContain("startAiGeneration");
		expect(script).toContain(
			"startAiGeneration(videoId as Video.VideoId, ownerId, observedState)",
		);
		expect(script).toContain("id: videos.id");
		expect(script).toContain("updatedAt: videos.updatedAt");
		expect(script).toContain(".limit(options.limit)");
		expect(script).not.toContain("summary: videos");
	});
});

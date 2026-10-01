import { getCurrentUser } from "@cap/database/auth/session";
import { organizations, spaceVideos, videoUploads } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as EffectRuntime from "@/lib/server";
import { transcribeVideo } from "@/lib/transcribe";

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

const queryResults = new Map<unknown, unknown[]>();

function queryBuilder() {
	let table: unknown;
	const builder = {
		select: () => builder,
		from: (nextTable: unknown) => {
			table = nextTable;
			return builder;
		},
		innerJoin: () => builder,
		where: () => {
			const rows = queryResults.get(table) ?? [];
			return Object.assign(Promise.resolve(rows), {
				limit: () => Promise.resolve(rows),
			});
		},
	};
	return builder;
}

vi.mock("@cap/database", () => ({
	db: () => queryBuilder(),
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ ASSEMBLY_API_KEY: "assembly-key" }),
}));
vi.mock("@/lib/desktop-segments-finalization", () => ({
	isRetryableDesktopSegmentsFinalizationError: () => false,
	queueDesktopSegmentsFinalization: vi.fn(),
}));
vi.mock("@/lib/generate-ai", () => ({ startAiGeneration: vi.fn() }));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));
vi.mock("@/lib/server", () => ({ runPromiseExit: vi.fn() }));

const { getVideoStatus } = await import("@/actions/videos/get-status");

describe("getVideoStatus upload handoff", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		queryResults.clear();
		vi.mocked(getCurrentUser).mockResolvedValue({ id: "owner-1" } as never);
		vi.mocked(EffectRuntime.runPromiseExit).mockResolvedValue({
			_tag: "Success",
			value: [
				{
					id: "video-1",
					ownerId: "owner-1",
					orgId: null,
					name: "Video",
					duration: 12,
					settings: {},
					metadata: { summary: "Owner edited summary" },
					transcriptionStatus: null,
					source: { type: "webMP4" },
				},
			],
		} as never);
		queryResults.set(organizations, []);
		queryResults.set(spaceVideos, []);
		queryResults.set(videoUploads, [
			{
				videoId: "video-1",
				phase: "processing",
				processingError: null,
			},
		]);
	});

	it("does not start transcription while the upload row is still active", async () => {
		await expect(
			getVideoStatus("video-1" as Video.VideoId),
		).resolves.toMatchObject({
			transcriptionStatus: null,
			summary: "Owner edited summary",
		});
		expect(transcribeVideo).not.toHaveBeenCalled();
	});
});

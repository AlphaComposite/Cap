import { getCurrentUser } from "@cap/database/auth/session";
import { organizations, spaceVideos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as EffectRuntime from "@/lib/server";

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

const queryResults = new Map<unknown, unknown[]>();
const tablesRead: unknown[] = [];

function queryBuilder() {
	let table: unknown;
	const builder = {
		select: () => builder,
		from: (nextTable: unknown) => {
			table = nextTable;
			tablesRead.push(nextTable);
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

vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@/lib/ai/provider", () => ({ isAiConfigured: () => false }));
vi.mock("@/lib/desktop-segments-finalization", () => ({
	isRetryableDesktopSegmentsFinalizationError: () => false,
	queueDesktopSegmentsFinalization: vi.fn(),
}));
vi.mock("@/lib/generate-ai", () => ({ startAiGeneration: vi.fn() }));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));
vi.mock("@/utils/flags", () => ({ isAiGenerationEnabled: vi.fn() }));
vi.mock("@/lib/server", () => ({ runPromiseExit: vi.fn() }));

const metadata: VideoMetadata = {
	summary: "Private summary",
	chapters: [{ title: "Private chapter", start: 0 }],
	aiGenerationStatus: "COMPLETE",
};

const baseVideo = {
	id: "video-1",
	ownerId: "owner-1",
	orgId: "org-1",
	name: "Video",
	settings: {},
	metadata,
	transcriptionStatus: "COMPLETE",
	source: { type: "local" },
};

const { getVideoStatus } = await import("@/actions/videos/get-status");

async function statusFor({
	viewerId = "viewer-1",
	videoSettings = {},
	organizationSettings = {},
	spaces = [],
}: {
	viewerId?: string;
	videoSettings?: Record<string, boolean>;
	organizationSettings?: Record<string, boolean>;
	spaces?: Array<{
		id: string;
		name: string;
		settings: Record<string, boolean>;
	}>;
}) {
	vi.mocked(getCurrentUser).mockResolvedValue({ id: viewerId } as never);
	vi.mocked(EffectRuntime.runPromiseExit).mockResolvedValue({
		_tag: "Success",
		value: [{ ...baseVideo, settings: videoSettings }],
	} as never);
	queryResults.set(organizations, [{ settings: organizationSettings }]);
	queryResults.set(spaceVideos, spaces);

	return getVideoStatus("video-1" as Video.VideoId);
}

describe("getVideoStatus AI visibility", () => {
	beforeEach(() => {
		queryResults.clear();
		tablesRead.length = 0;
		vi.clearAllMocks();
	});

	it("applies space disables over explicit video and organization enables for a non-owner", async () => {
		const result = await statusFor({
			videoSettings: { disableSummary: false, disableChapters: false },
			organizationSettings: {
				disableSummary: false,
				disableChapters: false,
			},
			spaces: [
				{
					id: "space-1",
					name: "Private space",
					settings: { disableSummary: true, disableChapters: true },
				},
			],
		});

		expect(tablesRead).toContain(spaceVideos);
		expect(result).toMatchObject({ summary: null, chapters: null });
	});

	it("retains space-disabled AI data for the owner", async () => {
		const result = await statusFor({
			viewerId: "owner-1",
			spaces: [
				{
					id: "space-1",
					name: "Private space",
					settings: { disableSummary: true, disableChapters: true },
				},
			],
		});

		expect(result).toMatchObject({
			summary: metadata.summary,
			chapters: metadata.chapters,
		});
	});

	it("uses explicit video enables over organization disables for a non-owner", async () => {
		const result = await statusFor({
			videoSettings: { disableSummary: false, disableChapters: false },
			organizationSettings: {
				disableSummary: true,
				disableChapters: true,
			},
		});

		expect(result).toMatchObject({
			summary: metadata.summary,
			chapters: metadata.chapters,
		});
	});

	it("inherits organization disables for a non-owner when video settings are unset", async () => {
		const result = await statusFor({
			organizationSettings: {
				disableSummary: true,
				disableChapters: true,
			},
		});

		expect(result).toMatchObject({ summary: null, chapters: null });
	});
});

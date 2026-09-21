import { resolveEffectiveVideoRules } from "@cap/web-backend";
import { describe, expect, it } from "vitest";
import {
	filterAiDataForViewer,
	filterVideoMetadataForViewer,
} from "@/lib/server-ai-data-visibility";

const metadata = {
	aiTitle: "Generated title",
	summary: "Private generated summary",
	chapters: [{ title: "Introduction", start: 0 }],
	aiGenerationStatus: "COMPLETE" as const,
};

const rulesFor = ({
	videoSettings,
	organizationSettings,
}: {
	videoSettings?: { disableSummary?: boolean; disableChapters?: boolean };
	organizationSettings?: {
		disableSummary?: boolean;
		disableChapters?: boolean;
	};
}) =>
	resolveEffectiveVideoRules({
		videoSettings,
		organizationSettings,
		spaces: [],
	});

describe("server AI data visibility", () => {
	it("removes a video-disabled summary for a non-owner without removing enabled chapters", () => {
		const rules = rulesFor({
			videoSettings: { disableSummary: true, disableChapters: false },
			organizationSettings: { disableSummary: false },
		});

		expect(
			filterAiDataForViewer(metadata, rules.settings, false),
		).toMatchObject({
			summary: null,
			chapters: metadata.chapters,
		});
	});

	it("retains a video-disabled summary for the owner", () => {
		const rules = rulesFor({
			videoSettings: { disableSummary: true },
			organizationSettings: { disableSummary: false },
		});

		expect(filterAiDataForViewer(metadata, rules.settings, true).summary).toBe(
			metadata.summary,
		);
	});

	it("removes an organization-disabled summary when the video inherits the setting", () => {
		const rules = rulesFor({
			videoSettings: {},
			organizationSettings: { disableSummary: true },
		});

		expect(filterAiDataForViewer(metadata, rules.settings, false).summary).toBe(
			null,
		);
	});

	it("lets a video override an organization-disabled summary", () => {
		const rules = rulesFor({
			videoSettings: { disableSummary: false },
			organizationSettings: { disableSummary: true },
		});

		expect(filterAiDataForViewer(metadata, rules.settings, false).summary).toBe(
			metadata.summary,
		);
	});

	it("filters chapters independently and retains disabled chapters for the owner", () => {
		const rules = rulesFor({
			videoSettings: { disableSummary: false, disableChapters: true },
		});

		expect(
			filterAiDataForViewer(metadata, rules.settings, false),
		).toMatchObject({
			summary: metadata.summary,
			chapters: null,
		});
		expect(filterAiDataForViewer(metadata, rules.settings, true)).toMatchObject(
			{
				summary: metadata.summary,
				chapters: metadata.chapters,
			},
		);
	});

	it("removes disabled AI fields from non-owner metadata without altering unrelated fields", () => {
		const viewerMetadata = filterVideoMetadataForViewer(
			{
				...metadata,
				customCreatedAt: "2026-09-21T12:00:00.000Z",
			},
			{ disableSummary: true, disableChapters: true },
			false,
		);

		expect(viewerMetadata).not.toHaveProperty("summary");
		expect(viewerMetadata).not.toHaveProperty("chapters");
		expect(viewerMetadata).toMatchObject({
			aiTitle: metadata.aiTitle,
			aiGenerationStatus: metadata.aiGenerationStatus,
			customCreatedAt: "2026-09-21T12:00:00.000Z",
		});
	});

	it("retains complete metadata for the owner when AI fields are disabled", () => {
		const viewerMetadata = filterVideoMetadataForViewer(
			metadata,
			{ disableSummary: true, disableChapters: true },
			true,
		);

		expect(viewerMetadata).toEqual(metadata);
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	pro: vi.fn(),
	db: vi.fn(),
	readiness: vi.fn(),
	open: vi.fn(),
	download: vi.fn(),
	flag: vi.fn(),
	editSource: vi.fn(),
}));
const schema = vi.hoisted(() => ({
	videos: { id: "videos" },
	videoUploads: { videoId: "uploads" },
	videoEdits: { videoId: "edits" },
	editIntent: {},
	editRevision: {},
	videoPublication: {},
}));
vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@cap/database/schema", () => schema);
vi.mock("@cap/utils", () => ({ userIsPro: mocks.pro }));
vi.mock("@cap/web-domain", () => ({
	Video: { VideoId: { make: (value: string) => value } },
}));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NOT_FOUND");
	},
}));
vi.mock("@/actions/videos/get-edit-readiness", () => ({
	getEditReadiness: mocks.readiness,
}));
vi.mock("@/actions/videos/download", () => ({
	getVideoDownloadInfo: mocks.download,
}));
vi.mock("@/lib/revision-publication-read", () => ({
	openInstantFinishEditor: mocks.open,
	selectEditorPlayback: () => ({
		playbackSrc: "synthetic",
		usesOriginalSource: false,
	}),
}));
vi.mock("@/lib/editor-baseline", () => ({
	editorHasExistingEdits: () => false,
	selectEditorBaselineSpec: () => ({}),
}));
vi.mock("@/lib/instant-finish-flag", () => ({
	isInstantFinishEnabledForOwner: mocks.flag,
}));
vi.mock("@/lib/video-edit-processing", () => ({
	isEditSourceKey: mocks.editSource,
}));
vi.mock("@/app/s/[videoId]/edit/EditVideoClient", () => ({
	EditVideoClient: () => null,
}));
vi.mock("@/app/s/[videoId]/edit/EditUpgradeGate", () => ({
	EditUpgradeGate: () => null,
}));
vi.mock("@/app/s/[videoId]/edit/edit-recovery", () => ({
	EditRecovery: () => null,
}));
vi.mock("@/app/s/[videoId]/edit/EditReadinessGate", () => ({
	EditReadinessGate: () => null,
}));

import { EditReadinessGate } from "../../app/s/[videoId]/edit/EditReadinessGate";
import { EditUpgradeGate } from "../../app/s/[videoId]/edit/EditUpgradeGate";
import { EditVideoClient } from "../../app/s/[videoId]/edit/EditVideoClient";
import { EditRecovery } from "../../app/s/[videoId]/edit/edit-recovery";
import Page from "../../app/s/[videoId]/edit/page";
import { RevisionPublicationError } from "../../lib/revision-publication-metadata";

let video: Record<string, unknown>;
beforeEach(() => {
	video = {
		id: "video",
		name: "Synthetic",
		ownerId: "owner",
		duration: 20,
		source: { type: "webMP4" },
		transcriptionStatus: "PROCESSING",
	};
	mocks.user.mockResolvedValue({ id: "owner" });
	mocks.pro.mockReturnValue(true);
	mocks.flag.mockReturnValue(false);
	mocks.editSource.mockReturnValue(false);
	mocks.readiness.mockResolvedValue({
		status: "ready",
		readiness: { manualEditing: true },
	});
	mocks.db.mockImplementation(() => {
		let table: unknown;
		const chain = {
			select: () => chain,
			from: (value: unknown) => {
				table = value;
				return chain;
			},
			leftJoin: () => chain,
			innerJoin: () => chain,
			where: async () => (table === schema.videos ? [video] : []),
		};
		return chain;
	});
});
const page = () => Page({ params: Promise.resolve({ videoId: "video" }) });
describe("direct editor admission before mutations", () => {
	it.each(["uploading", "processing", "generating_thumbnail", "error"])(
		"shows authorized preparation for %s instead of404",
		async (phase) => {
			video.uploadPhase = phase;
			expect((await page()).type).toBe(EditReadinessGate);
			expect(mocks.open).not.toHaveBeenCalled();
			expect(mocks.download).not.toHaveBeenCalled();
		},
	);
	it("shows preparation when source duration is not known", async () => {
		video.duration = null;
		expect((await page()).type).toBe(EditReadinessGate);
		expect(mocks.open).not.toHaveBeenCalled();
	});
	it("keeps missing/nonowner/screenshot/unsupported concealed", async () => {
		for (const change of [
			{ ownerId: "other" },
			{ isScreenshot: true },
			{ source: { type: "local" } },
		]) {
			const original = { ...video };
			Object.assign(video, change);
			await expect(page()).rejects.toThrow("NOT_FOUND");
			video = original;
		}
		expect(mocks.readiness).not.toHaveBeenCalled();
	});
	it("keeps upgrade ahead of preparation", async () => {
		mocks.pro.mockReturnValue(false);
		video.uploadPhase = "processing";
		expect((await page()).type).toBe(EditUpgradeGate);
	});
	it("preserves the edit-source recovery branch", async () => {
		video.uploadPhase = "processing";
		mocks.editSource.mockReturnValue(true);
		expect((await page()).type).toBe(EditRecovery);
	});
	it("fails closed on missing read admission before editor open", async () => {
		mocks.flag.mockReturnValue(true);
		mocks.readiness.mockResolvedValue({ status: "unavailable" });
		expect((await page()).type).toBe(EditReadinessGate);
		expect(mocks.open).not.toHaveBeenCalled();
	});
	it("lets transcript-only pending enter the manual editor", async () => {
		expect((await page()).type).toBe(EditVideoClient);
		expect(mocks.readiness).toHaveBeenCalledWith("video", true, false);
	});
	it("waits when fresh admission rejects an advisory ready hint", async () => {
		mocks.flag.mockReturnValue(true);
		mocks.readiness.mockImplementation(
			async (_videoId, _transcript, usePlaybackHint) => ({
				status: "ready",
				readiness: { manualEditing: usePlaybackHint !== false },
			}),
		);
		expect((await page()).type).toBe(EditReadinessGate);
		expect(mocks.readiness).toHaveBeenCalledWith("video", true, false);
		expect(mocks.open).not.toHaveBeenCalled();
	});
	it("renders preparation on a source-not-ready race instead of throwing", async () => {
		mocks.flag.mockReturnValue(true);
		mocks.open.mockRejectedValue(
			new RevisionPublicationError(
				409,
				"Registered source is not ready; retry",
			),
		);
		expect((await page()).type).toBe(EditReadinessGate);
	});
	it("does not hide source integrity conflicts", async () => {
		mocks.flag.mockReturnValue(true);
		mocks.open.mockRejectedValue(
			new RevisionPublicationError(
				409,
				"Source identity changed after it was recorded",
			),
		);
		await expect(page()).rejects.toThrow("Source identity changed");
	});
});

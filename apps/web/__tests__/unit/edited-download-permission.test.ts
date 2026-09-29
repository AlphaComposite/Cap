import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	canDownload: vi.fn(),
	artifactUrl: vi.fn(async () => "https://origin.test/download.mp4?t=grant"),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
}));
vi.mock("@/lib/video-download-permissions", () => ({
	canUserDownloadVideo: mocks.canDownload,
}));
vi.mock("@/lib/revision-media-grant", () => ({
	revisionArtifactUrl: mocks.artifactUrl,
}));
vi.mock("@cap/web-backend", async () => {
	const edited = await import(
		"../../../../packages/web-backend/src/Videos/editedDownload"
	);
	return {
		registerEditedDownloadUrlLookup: edited.registerEditedDownloadUrlLookup,
		currentEditedDownloadUrlLookup: edited.currentEditedDownloadUrlLookup,
	};
});

import { ensureEditedDownloadLookup } from "@/lib/register-edited-download";
import {
	currentEditedDownloadUrlLookup,
	editedDownloadFromLookup,
} from "../../../../packages/web-backend/src/Videos/editedDownload";

const backendSource = readFileSync(
	new URL(
		"../../../../packages/web-backend/src/Videos/index.ts",
		import.meta.url,
	),
	"utf8",
);
const downloadInfoSource = backendSource.slice(
	backendSource.indexOf("getDownloadInfo:"),
	backendSource.indexOf("getThumbnailURL:"),
);

const readyUrl = "https://origin.test/download.mp4?t=grant";

describe("edited download permission", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.canDownload.mockResolvedValue(false);
		mocks.artifactUrl.mockResolvedValue(readyUrl);
		ensureEditedDownloadLookup();
	});

	it("returns a URL only for a permitted caller, and refuses anonymous and viewable-but-not-permitted callers without minting", async () => {
		const lookup = currentEditedDownloadUrlLookup();
		expect(lookup).toBeTruthy();
		if (!lookup) throw new Error("lookup missing");

		mocks.canDownload.mockResolvedValue(true);
		await expect(
			lookup({ videoId: "video", ownerId: "owner", userId: "owner" }),
		).resolves.toEqual({ status: "allowed", downloadUrl: readyUrl });
		expect(mocks.artifactUrl).toHaveBeenCalledTimes(1);

		mocks.artifactUrl.mockClear();
		mocks.canDownload.mockClear();
		mocks.canDownload.mockResolvedValue(false);
		await expect(
			lookup({ videoId: "video", ownerId: "owner", userId: "viewer" }),
		).resolves.toEqual({ status: "forbidden" });
		await expect(
			lookup({ videoId: "video", ownerId: "owner", userId: null }),
		).resolves.toEqual({ status: "forbidden" });
		expect(mocks.canDownload).toHaveBeenCalledTimes(1);
		expect(mocks.artifactUrl).not.toHaveBeenCalled();
	});

	it("maps forbidden to a refusal before preparing or a URL", () => {
		expect(
			editedDownloadFromLookup({
				name: "Edited clip",
				lookup: { status: "forbidden" },
			}),
		).toEqual({ status: "forbidden" });
		expect(
			editedDownloadFromLookup({ name: "Edited clip", lookup: null }),
		).toEqual({ status: "forbidden" });
		expect(
			editedDownloadFromLookup({
				name: "Edited clip",
				lookup: { status: "allowed", downloadUrl: null },
			}),
		).toEqual({
			status: "preparing",
			message: "Preparing your download. Try again in a minute.",
		});
		expect(
			editedDownloadFromLookup({
				name: "Edited clip",
				lookup: { status: "allowed", downloadUrl: readyUrl },
			}),
		).toEqual({
			status: "ready",
			fileName: "Edited clip.mp4",
			downloadUrl: readyUrl,
		});

		const forbiddenAt = downloadInfoSource.indexOf('status === "forbidden"');
		const preparingAt = downloadInfoSource.indexOf("DownloadPreparingError");
		expect(forbiddenAt).toBeGreaterThan(-1);
		expect(preparingAt).toBeGreaterThan(forbiddenAt);
		expect(downloadInfoSource).toContain("PolicyDeniedError");
		expect(downloadInfoSource).toContain("userId");
	});
});

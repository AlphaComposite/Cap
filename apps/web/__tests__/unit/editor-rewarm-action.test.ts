import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const harness = vi.hoisted(() => ({
	owner: vi.fn(),
	enabled: vi.fn(),
	open: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@/lib/revision-publish", () => ({ loadOwnerVideo: harness.owner }));
vi.mock("@/lib/instant-finish-flag", () => ({
	isInstantFinishEnabledForOwner: harness.enabled,
}));
vi.mock("@/lib/revision-publication-read", () => ({
	openInstantFinishEditor: harness.open,
}));

import { rewarmEditorSource } from "@/actions/videos/publish-revision";
import { RevisionPublicationError } from "@/lib/revision-publication";

const videoId = "video-1" as Parameters<typeof rewarmEditorSource>[0];

beforeEach(() => {
	vi.resetAllMocks();
	harness.owner.mockResolvedValue({ video: { ownerId: "owner-1" } });
	harness.enabled.mockReturnValue(true);
	harness.open.mockResolvedValue({ generation: 4, draftSession: "draft-1" });
});

describe("editor source re-warm action", () => {
	it("checks the owner before using the existing editor-open path once", async () => {
		expect(await rewarmEditorSource(videoId)).toEqual({ success: true });
		expect(harness.owner).toHaveBeenCalledExactlyOnceWith(videoId);
		expect(harness.enabled).toHaveBeenCalledExactlyOnceWith("owner-1");
		expect(harness.open).toHaveBeenCalledExactlyOnceWith(videoId);
		expect(harness.owner.mock.invocationCallOrder[0]).toBeLessThan(
			harness.open.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("does not warm when the owner check rejects", async () => {
		harness.owner.mockRejectedValue(
			new RevisionPublicationError(403, "Forbidden"),
		);
		expect(await rewarmEditorSource(videoId)).toEqual({
			success: false,
			error: "Forbidden",
		});
		expect(harness.open).not.toHaveBeenCalled();
	});

	it("does not warm a flag-off video", async () => {
		harness.enabled.mockReturnValue(false);
		expect(await rewarmEditorSource(videoId)).toEqual({
			success: false,
			error: "Instant finish is not enabled for this video",
		});
		expect(harness.open).not.toHaveBeenCalled();
	});

	it("returns the server reason as data instead of a production-redacted action exception", async () => {
		const message = "Source identity changed after it was recorded";
		harness.open.mockRejectedValue(new RevisionPublicationError(409, message));
		expect(await rewarmEditorSource(videoId)).toEqual({
			success: false,
			error: message,
		});
		expect(harness.open).toHaveBeenCalledTimes(1);
	});
});

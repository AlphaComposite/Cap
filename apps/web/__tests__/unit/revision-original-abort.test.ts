import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://127.0.0.1:32120" },
	serverEnv: () => ({
		NEXTAUTH_SECRET: "test-secret-with-enough-entropy",
		WEB_URL: "http://127.0.0.1:32120",
	}),
}));

const getCurrentUser = vi.hoisted(() => vi.fn());
const select = vi.hoisted(() => vi.fn());
const getAccessForVideo = vi.hoisted(() => vi.fn());
const getObjectResponse = vi.hoisted(() => vi.fn());

vi.mock("@cap/database/auth/session", () => ({ getCurrentUser }));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: select,
			}),
		}),
	}),
}));
vi.mock("@cap/database/schema", () => ({ videos: { id: "id" } }));
vi.mock("@cap/web-backend", () => ({
	Storage: { getAccessForVideo },
}));
vi.mock("@cap/web-domain", () => ({
	Video: { VideoId: { make: (value: string) => value } },
}));
vi.mock("@/lib/instant-finish-flag", () => ({
	isInstantFinishEnabledForOwner: () => true,
}));
vi.mock("@/lib/private-source-read", () => ({
	ownerOriginalObjectKey: async () => "owner/video/original.mp4",
	privateSourceHeaders: () => new Headers(),
}));
vi.mock("@/lib/server", () => ({
	runPromise: async (effect: { run: () => Promise<unknown> }) => effect.run(),
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));

function originalRequest(signal?: AbortSignal) {
	return new NextRequest(
		"http://127.0.0.1:32120/api/media/original?videoId=video-1",
		{ method: "GET", signal },
	);
}

describe("aborted original range reads", () => {
	beforeEach(() => {
		getCurrentUser.mockResolvedValue({ id: "owner-1" });
		select.mockResolvedValue([
			{ id: "video-1", ownerId: "owner-1", source: { type: "webMP4" } },
		]);
		getAccessForVideo.mockReturnValue({
			pipe: (
				run: (effect: { run: () => Promise<unknown> }) => Promise<unknown>,
			) =>
				run({
					run: async () => [{ getObjectResponse }],
				}),
		});
	});

	it("returns 499 and does not log an aborted range read", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		getObjectResponse.mockReturnValue({
			pipe: (
				run: (effect: { run: () => Promise<unknown> }) => Promise<unknown>,
			) =>
				run({
					run: async () => {
						throw new DOMException("The operation was aborted.", "AbortError");
					},
				}),
		});
		const { GET } = await import("@/app/api/media/original/route");
		const response = await GET(originalRequest());
		expect(response.status).toBe(499);
		expect(errorSpy).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("still throws a real storage failure", async () => {
		getObjectResponse.mockReturnValue({
			pipe: (
				run: (effect: { run: () => Promise<unknown> }) => Promise<unknown>,
			) =>
				run({
					run: async () => {
						throw new Error("InvalidAccessKeyId");
					},
				}),
		});
		const { GET } = await import("@/app/api/media/original/route");
		await expect(GET(originalRequest())).rejects.toThrow(/InvalidAccessKeyId/);
	});
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiUrl,
	createAuthStart,
	createInstantRecording,
	deleteInstantRecording,
	fetchBootstrap,
	revokeAuth,
	updateUploadProgress,
} from "./api";
import { defaultSettings } from "./storage";

const settings = { ...defaultSettings, apiBaseUrl: "" };
const auth = { authApiKey: "test-token", userId: "user" };
const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.stubGlobal("chrome", {
		identity: { getRedirectURL: () => "https://extension.example.com/" },
	});
});
afterEach(() => vi.unstubAllGlobals());

describe("configured server URL", () => {
	it("rejects an empty base with a clear error before auth or any API fetch", async () => {
		for (const request of [
			() => createAuthStart(settings),
			() => fetchBootstrap(settings, auth),
			() => revokeAuth(settings, auth),
			() => deleteInstantRecording(settings, auth, "video"),
			() =>
				createInstantRecording({
					settings,
					auth,
					input: { orgId: "org", folderId: undefined, resolution: "1920x1080" },
				}),
			() =>
				updateUploadProgress({
					settings,
					auth,
					videoId: "video",
					uploaded: 0,
					total: 1,
				}),
		]) {
			await expect(request()).rejects.toThrow(/server URL not set/i);
		}
		expect(fetchMock).not.toHaveBeenCalled();
		expect(() => apiUrl(settings, "/dashboard")).toThrow(/server URL not set/i);
	});

	it.each([" ", "/server", "file:///server", "ftp://cap.example.com"])(
		"rejects invalid base %s without fetching",
		async (apiBaseUrl) => {
			await expect(
				createAuthStart({ ...settings, apiBaseUrl }),
			).rejects.toThrow(/Cap server URL/i);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("uses the configured server for API, dashboard and pricing URLs", async () => {
		const configured = { ...settings, apiBaseUrl: "https://cap.example.com/" };
		for (const path of ["/api/extension/bootstrap", "/dashboard", "/pricing"]) {
			expect(apiUrl(configured, path)).toBe(`https://cap.example.com${path}`);
		}
		fetchMock.mockResolvedValue({ ok: true });
		const start = await createAuthStart(configured);
		expect(new URL(start.url).origin).toBe("https://cap.example.com");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});

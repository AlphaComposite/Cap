import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_KEY } from "../shared/storage";

const boot = async (url: string, apiBaseUrl: string) => {
	vi.resetModules();
	Reflect.deleteProperty(globalThis, "__capExtensionContentBootstrap");
	const page = new EventTarget();
	Object.assign(page, { location: new URL(url) });
	const setAttribute = vi.fn();
	const sendMessage = vi.fn();
	const localGet = vi.fn((_keys, callback) =>
		callback({ [SETTINGS_KEY]: { apiBaseUrl } }),
	);
	vi.stubGlobal("window", page);
	vi.stubGlobal("document", { documentElement: { setAttribute } });
	vi.stubGlobal("chrome", {
		runtime: {
			getURL: (path: string) => `chrome-extension://test/${path}`,
			onMessage: { addListener: vi.fn() },
			sendMessage,
		},
		storage: {
			local: { get: localGet },
			session: {
				get: (_keys: string[], callback: (items: object) => void) =>
					callback({}),
			},
			onChanged: { addListener: vi.fn() },
		},
	});
	await import("./bootstrap");
	return { page, setAttribute, sendMessage, localGet };
};

afterEach(() => {
	vi.unstubAllGlobals();
	Reflect.deleteProperty(globalThis, "__capExtensionContentBootstrap");
});

describe("configured page bridge", () => {
	it("matches the configured hostname from storage without waking the worker", async () => {
		const bridge = await boot(
			"https://cap.example.com/dashboard",
			"https://cap.example.com/",
		);
		expect(bridge.localGet).toHaveBeenCalledOnce();
		expect(bridge.setAttribute).toHaveBeenCalledWith(
			"data-cap-chrome-extension-installed",
			"true",
		);
		expect(bridge.sendMessage).not.toHaveBeenCalled();
		bridge.page.dispatchEvent(new Event("cap-chrome-extension-open"));
		expect(bridge.sendMessage).toHaveBeenCalledOnce();
	});

	it.each([
		"https://other.example.com",
		"https://sub.cap.example.com",
		"https://cap.so",
		"https://app.cap.so",
	])("does not bridge unrelated host %s", async (url) => {
		const bridge = await boot(url, "https://cap.example.com");
		expect(bridge.setAttribute).not.toHaveBeenCalled();
		bridge.page.dispatchEvent(new Event("cap-chrome-extension-open"));
		expect(bridge.sendMessage).not.toHaveBeenCalled();
	});

	it.each([
		"http://localhost:3000",
		"http://127.0.0.1:3000",
		"http://[::1]:3000",
	])("keeps local bridge %s without a server configured", async (url) => {
		const bridge = await boot(url, "");
		expect(bridge.setAttribute).toHaveBeenCalledOnce();
	});

	it.each(["", "invalid", "file://cap.example.com"])(
		"does not bridge an invalid configured URL %s",
		async (apiBaseUrl) => {
			const bridge = await boot("https://cap.example.com", apiBaseUrl);
			expect(bridge.setAttribute).not.toHaveBeenCalled();
		},
	);

	it("still bridges a saved hosted server URL", async () => {
		const bridge = await boot("https://cap.so/dashboard", "https://cap.so");
		expect(bridge.setAttribute).toHaveBeenCalledOnce();
	});

	it("does not read server settings or bridge non-web pages", async () => {
		const bridge = await boot(
			"file:///capture.html",
			"https://cap.example.com",
		);
		expect(bridge.localGet).not.toHaveBeenCalled();
		expect(bridge.setAttribute).not.toHaveBeenCalled();
	});
});

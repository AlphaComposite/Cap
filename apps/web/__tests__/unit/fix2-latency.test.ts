import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
	clearPrefetchedFragments,
	createPrefetchLoader,
	readPrefetchedFragment,
	rememberPrefetchedFragment,
} from "@/lib/instant-finish-fragment-cache";
import { previewRedirectOrigin } from "@/lib/mobile-request-origin";
import { passwordCookieSecure } from "@/lib/password-cookie-secure";
import { doneRoute } from "@/lib/revision-done";
import {
	displayedSeekTime,
	reconcileSeekSample,
	subscribeSeekClock,
	watchElementClock,
} from "@/lib/revision-seek-clock";
import { warmSourceFromRow } from "@/lib/revision-source-warm";

describe("preview redirect origin", () => {
	it("uses WEB_URL instead of a 0.0.0.0 bind address", () => {
		expect(
			previewRedirectOrigin(
				"http://127.0.0.1:32120",
				"http://0.0.0.0:32120/api/video/preview",
				"127.0.0.1:32120",
			),
		).toBe("http://127.0.0.1:32120");
		expect(
			previewRedirectOrigin(
				"http://127.0.0.1:32120",
				"http://0.0.0.0:32120/api/video/preview",
				"0.0.0.0:32120",
			),
		).toBe("http://127.0.0.1:32120");
	});
});

describe("password cookie scheme", () => {
	it("keeps Secure on https and drops it on http", () => {
		expect(passwordCookieSecure("https://cap.example.com")).toBe(true);
		expect(passwordCookieSecure("http://127.0.0.1:32120")).toBe(false);
	});
});

describe("done before instant-finish state", () => {
	it("does not save until the state resolves enabled false", () => {
		expect(doneRoute(undefined)).toBe("wait");
		expect(doneRoute(null)).toBe("wait");
		expect(doneRoute({ enabled: false })).toBe("save");
		expect(doneRoute({ enabled: true })).toBe("publish");
	});
});

describe("editor action refresh", () => {
	it("reuses a warm source row instead of preparing again", () => {
		const now = new Date("2026-09-26T12:00:00Z");
		const row = {
			liveKey: "owner/video/source/original.mp4",
			sha256: "a".repeat(64),
			relocationState: "LIVE",
			codec: "h264",
			timebase: "1/15360",
			frameMode: "vfr",
			a1Digest: "b".repeat(64),
			indexId: "index",
			warmExpiresAt: new Date("2026-09-26T12:10:00Z"),
		};
		expect(warmSourceFromRow(row, now)?.sha256).toBe(row.sha256);
		expect(
			warmSourceFromRow(
				{ ...row, warmExpiresAt: new Date("2026-09-26T11:00:00Z") },
				now,
			),
		).toBeNull();
	});
});

describe("seek clock without media events", () => {
	it("reads a currentTime write that emits no seeked or timeupdate", () => {
		const frames: Array<() => void> = [];
		const media = {
			currentTime: 0,
			addEventListener() {},
			removeEventListener() {},
		};
		const samples: number[] = [];
		subscribeSeekClock(media, (time) => samples.push(time));
		const stop = watchElementClock(media, {
			requestFrame: (callback) => {
				frames.push(callback);
				return frames.length;
			},
		});
		media.currentTime = 5;
		frames.shift()?.();
		for (const frame of frames.splice(0)) frame();
		expect(samples).toContain(5);
		stop();
	});

	it("does not keep a failed seek target after the element reverts", () => {
		expect(reconcileSeekSample(3.9, 71, 3.9)).toBeNull();
		expect(displayedSeekTime(3.9, 71, 3.9)).toBe(3.9);
		expect(displayedSeekTime(71, 71, 71)).toBe(71);
	});
});

describe("prefetched fragment loader", () => {
	it("serves the prefetched seg0 bytes without another load", () => {
		clearPrefetchedFragments();
		const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
		const url = "http://127.0.0.1:32120/media/v/r/rev/seg/0.m4s?t=grant";
		rememberPrefetchedFragment(url, bytes);
		expect(readPrefetchedFragment(url)).toBe(bytes);
		const network = vi.fn();
		class Base {
			load(_context?: unknown, _config?: unknown, _callbacks?: unknown) {
				network();
			}
		}
		const Loader = createPrefetchLoader(Base);
		const loader = new Loader();
		const success = vi.fn();
		loader.load({ url }, {}, { onSuccess: success });
		expect(network).not.toHaveBeenCalled();
		expect(success).toHaveBeenCalled();
		expect(success.mock.calls[0]?.[0].data).toBe(bytes);
	});
});

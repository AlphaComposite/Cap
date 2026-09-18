// @vitest-environment jsdom

import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRenewingPlaybackSource } from "@/app/s/[videoId]/edit/use-renewing-playback-source";

function Harness({
	initialSrc,
	refresh,
}: {
	initialSrc: string;
	refresh: () => Promise<string | null>;
}) {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const source = useRenewingPlaybackSource({
		initialSrc,
		enabled: true,
		videoRef,
		refresh,
		refreshMs: 1_000,
		retryMs: 100,
	});
	return createElement(
		"div",
		null,
		createElement("output", null, source),
		createElement("video", { key: source, ref: videoRef, src: source }),
	);
}

describe("renewing original playback source", () => {
	let root: Root;
	let container: HTMLDivElement;

	beforeEach(() => {
		vi.useFakeTimers();
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
	});

	it("renews the signed source before expiry", async () => {
		const refresh = vi.fn().mockResolvedValue("https://storage.test/renewed");
		await act(async () => {
			root.render(
				createElement(Harness, {
					initialSrc: "https://storage.test/initial",
					refresh,
				}),
			);
		});

		expect(container.querySelector("output")?.textContent).toBe(
			"https://storage.test/initial",
		);
		const originalPlayer = container.querySelector("video");
		if (!originalPlayer) throw new Error("Expected initial video");
		originalPlayer.currentTime = 12;
		await act(async () => vi.advanceTimersByTimeAsync(1_000));
		expect(refresh).toHaveBeenCalledOnce();
		expect(container.querySelector("output")?.textContent).toBe(
			"https://storage.test/renewed",
		);
		const replacementPlayer = container.querySelector("video");
		expect(replacementPlayer).not.toBe(originalPlayer);
		await act(async () => {
			vi.advanceTimersByTime(20);
			replacementPlayer?.dispatchEvent(new Event("loadedmetadata"));
		});
		expect(replacementPlayer?.currentTime).toBe(12);
	});

	it("retries quickly when renewal temporarily fails", async () => {
		const refresh = vi
			.fn()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce("https://storage.test/recovered");
		await act(async () => {
			root.render(
				createElement(Harness, {
					initialSrc: "https://storage.test/initial",
					refresh,
				}),
			);
		});

		await act(async () => vi.advanceTimersByTimeAsync(1_000));
		expect(container.querySelector("output")?.textContent).toBe(
			"https://storage.test/initial",
		);
		await act(async () => vi.advanceTimersByTimeAsync(100));
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(container.querySelector("output")?.textContent).toBe(
			"https://storage.test/recovered",
		);
	});
});

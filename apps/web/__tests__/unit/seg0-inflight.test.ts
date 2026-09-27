import { describe, expect, it, vi } from "vitest";
import {
	clearPrefetchedFragments,
	createPrefetchLoader,
	readPrefetchedFragment,
	registerInflightFragment,
	rememberPrefetchedFragment,
} from "@/lib/instant-finish-fragment-cache";
import { prefetchInstantFinishPlaylist } from "@/lib/instant-finish-playback-handoff";

const url = "http://127.0.0.1:32120/media/v/r/rev/seg/0.m4s?t=grant-same";

function loader() {
	const network = vi.fn();
	class Base {
		load(_context?: unknown, _config?: unknown, _callbacks?: unknown) {
			network();
		}
	}
	const Loader = createPrefetchLoader(Base);
	return { network, loader: new Loader() };
}

describe("seg0 duplicate", () => {
	it("does not hit the network when a load starts before rememberPrefetchedFragment", () => {
		clearPrefetchedFragments();
		const { network, loader: item } = loader();
		const success = vi.fn();
		item.load({ url }, {}, { onSuccess: success });
		expect(network).not.toHaveBeenCalled();
		expect(success).not.toHaveBeenCalled();
		const bytes = new Uint8Array([7, 7, 7]).buffer;
		rememberPrefetchedFragment(url, bytes);
		expect(success).toHaveBeenCalled();
		expect(success.mock.calls[0]?.[0].data).toBe(bytes);
		expect(readPrefetchedFragment(url)).toBeNull();
		expect(network).not.toHaveBeenCalled();
	});

	it("awaits an in-flight prefetch registered before the body arrives", async () => {
		clearPrefetchedFragments();
		let resolveBytes: (bytes: ArrayBuffer) => void = () => {};
		const pending = new Promise<ArrayBuffer>((resolve) => {
			resolveBytes = resolve;
		});
		registerInflightFragment(url, pending);
		const { network, loader: item } = loader();
		const success = vi.fn();
		item.load({ url }, {}, { onSuccess: success });
		await Promise.resolve();
		expect(network).not.toHaveBeenCalled();
		expect(success).not.toHaveBeenCalled();
		const bytes = new Uint8Array([9, 9]).buffer;
		resolveBytes(bytes);
		await vi.waitFor(() => expect(success).toHaveBeenCalled());
		expect(success.mock.calls[0]?.[0].data).toBe(bytes);
		expect(readPrefetchedFragment(url)).toBeNull();
		expect(network).not.toHaveBeenCalled();
	});

	it("registers seg0 before the prefetch body arrives", async () => {
		clearPrefetchedFragments();
		const playlist =
			'#EXTM3U\n#EXT-X-MAP:URI="init.mp4?t=grant-same"\nseg/0.m4s?t=grant-same\n';
		const bytes = new Uint8Array([3, 3, 3]).buffer;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				if (String(input).includes("playlist")) {
					return new Response(playlist, { status: 200 });
				}
				await gate;
				return new Response(bytes, { status: 200 });
			}),
		);
		prefetchInstantFinishPlaylist(
			"http://127.0.0.1:32120/media/v/r/rev/playlist.m3u8?t=grant-same",
		);
		await vi.waitFor(() => {
			const calls = vi.mocked(fetch).mock.calls.map((call) => String(call[0]));
			expect(calls.some((called) => called.includes("seg/0.m4s"))).toBe(true);
		});
		const { network, loader: item } = loader();
		const success = vi.fn();
		item.load({ url }, {}, { onSuccess: success });
		expect(network).not.toHaveBeenCalled();
		release();
		await vi.waitFor(() => expect(success).toHaveBeenCalled());
		expect(new Uint8Array(success.mock.calls[0]?.[0].data)).toEqual(
			new Uint8Array(bytes),
		);
		expect(readPrefetchedFragment(url)).toBeNull();
		expect(network).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("does not emit unhandledRejection when an inflight prefetch rejects", async () => {
		clearPrefetchedFragments();
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		try {
			registerInflightFragment(url, Promise.reject(new Error("prefetch")));
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRejection);
			clearPrefetchedFragments();
		}
	});
});

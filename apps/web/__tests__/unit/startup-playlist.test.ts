import { afterEach, expect, it, vi } from "vitest";
import {
	clearPrefetchedFragments,
	createPrefetchLoader,
	readPrefetchedFragment,
	rememberPrefetchedFragment,
} from "@/lib/instant-finish-fragment-cache";
import { prefetchInstantFinishPlaylist } from "@/lib/instant-finish-playback-handoff";
afterEach(() => {
	clearPrefetchedFragments();
	vi.unstubAllGlobals();
});
it("joins the handoff playlist and returns manifest text without a second GET", async () => {
	const url = "http://cap.local/media/v/r/new/playlist.m3u8?t=grant";
	const manifest =
		'#EXTM3U\n#EXT-X-MAP:URI="init.mp4?t=grant"\nseg/0.m4s?t=grant\nseg/1.m4s?t=grant\n';
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const fetchMock = vi.fn(async (input: string) => {
		if (input === url) {
			await gate;
			return new Response(manifest);
		}
		return new Response(new Uint8Array([1, 2]));
	});
	vi.stubGlobal("fetch", fetchMock);
	const network = vi.fn();
	class Base {
		load(_c: unknown, _config: unknown, _callbacks: unknown) {
			network();
		}
	}
	const Loader = createPrefetchLoader(Base),
		item = new Loader(),
		success = vi.fn();
	prefetchInstantFinishPlaylist(url);
	item.load({ url, responseType: "text" }, {}, { onSuccess: success });
	release();
	await vi.waitFor(() => expect(success).toHaveBeenCalledTimes(1));
	expect(success.mock.calls[0][0].data).toBe(manifest);
	expect(network).not.toHaveBeenCalled();
	expect(fetchMock.mock.calls.filter(([u]) => u === url)).toHaveLength(1);
	expect(readPrefetchedFragment(url)).toBeNull();
});
it("retains all four startup items, consuming only an exact grant key", () => {
	const base = "/media/v/r/new/",
		body = new Uint8Array([3]).buffer;
	for (const path of ["playlist.m3u8", "init.mp4", "seg/0.m4s", "seg/1.m4s"])
		rememberPrefetchedFragment(base + path + "?t=grant", body);
	expect(readPrefetchedFragment(base + "playlist.m3u8?t=other")).toBeNull();
	for (const path of ["playlist.m3u8", "init.mp4", "seg/0.m4s", "seg/1.m4s"])
		expect(readPrefetchedFragment(base + path + "?t=grant")).toBe(body);
});

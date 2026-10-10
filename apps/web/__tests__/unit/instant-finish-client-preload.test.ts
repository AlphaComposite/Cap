import { afterEach, expect, it, vi } from "vitest";
import { clearPrefetchedFragments } from "@/lib/instant-finish-fragment-cache";
import { prefetchInstantFinishPlaylist } from "@/lib/instant-finish-playback-handoff";

const share = vi.hoisted(() => ({ loaded: vi.fn(), render: vi.fn() }));
const player = vi.hoisted(() => ({ loaded: vi.fn(), render: vi.fn() }));
vi.mock("@/app/s/[videoId]/Share", () => {
	share.loaded();
	return { Share: share.render };
});
vi.mock("@/app/s/[videoId]/_components/HLSVideoPlayer", () => {
	player.loaded();
	return { HLSVideoPlayer: player.render };
});

const url = "/media/video/r/revision/playlist.m3u8?t=grant";
afterEach(() => {
	clearPrefetchedFragments();
	vi.unstubAllGlobals();
});

it("does not warm client code on the server or for an ungranted URL", async () => {
	const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
	vi.stubGlobal("fetch", fetchMock);
	prefetchInstantFinishPlaylist(url);
	await vi.dynamicImportSettled();
	expect(share.loaded).not.toHaveBeenCalled();
	expect(player.loaded).not.toHaveBeenCalled();
	vi.stubGlobal("window", {});
	prefetchInstantFinishPlaylist("/media/video/r/revision/playlist.m3u8");
	await vi.dynamicImportSettled();
	expect(share.loaded).not.toHaveBeenCalled();
	expect(player.loaded).not.toHaveBeenCalled();
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("warms share and HLS modules alongside handoff media, without waiting or mounting", async () => {
	vi.stubGlobal("window", {});
	const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
	vi.stubGlobal("fetch", fetchMock);
	expect(prefetchInstantFinishPlaylist(url)).toBeUndefined();
	// Neither the manifest nor SSR/router arrival has completed.
	expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, {
		credentials: "same-origin",
	});
	await vi.dynamicImportSettled();
	expect(share.loaded).toHaveBeenCalledTimes(1);
	expect(player.loaded).toHaveBeenCalledTimes(1);
	expect(share.render).not.toHaveBeenCalled();
	expect(player.render).not.toHaveBeenCalled();
});

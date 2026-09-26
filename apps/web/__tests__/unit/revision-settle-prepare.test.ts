import { afterEach, describe, expect, it, vi } from "vitest";
import { postRevisionRoute } from "@/lib/revision-publish-client";
import {
	acceptSettledPrepare,
	beginDoneFence,
	nextSettlePrepare,
} from "@/lib/revision-settle-fence";

describe("settle prepare fence", () => {
	it("aborts the in-flight prepare when Done starts and drops its generation", () => {
		const started = nextSettlePrepare(null, 0);
		const done = beginDoneFence(started.requestId, started.controller);
		expect(started.controller.signal.aborted).toBe(true);
		expect(acceptSettledPrepare(started.requestId, done.requestId)).toBe(false);
		expect(acceptSettledPrepare(done.requestId, done.requestId)).toBe(true);
	});

	it("does not let an older settle overwrite a newer one", () => {
		const first = nextSettlePrepare(null, 0);
		const second = nextSettlePrepare(first.controller, first.requestId);
		expect(first.controller.signal.aborted).toBe(true);
		expect(second.controller.signal.aborted).toBe(false);
		expect(acceptSettledPrepare(first.requestId, second.requestId)).toBe(false);
		expect(acceptSettledPrepare(second.requestId, second.requestId)).toBe(true);
	});
});

describe("postRevisionRoute abort", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("forwards an AbortSignal to fetch", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ revisionId: "rev" }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await postRevisionRoute(
			"/api/video/revision/prepare",
			{ videoId: "v" },
			controller.signal,
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/video/revision/prepare",
			expect.objectContaining({ signal: controller.signal }),
		);
	});
});

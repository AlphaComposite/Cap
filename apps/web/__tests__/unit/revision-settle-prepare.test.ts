import { afterEach, describe, expect, it, vi } from "vitest";
import { postRevisionRoute } from "@/lib/revision-publish-client";
import {
	acceptSettledPrepare,
	beginDoneFence,
	nextSettlePrepare,
	SETTLE_PREPARE_DEBOUNCE_MS,
	shouldJoinInflightPrepare,
	shouldStartPrepareOnPointerDown,
} from "@/lib/revision-settle-fence";

describe("settle prepare fence", () => {
	it("aborts a mismatched prepare at Done and joins a matching one", () => {
		const started = nextSettlePrepare(null, 0);
		const mismatched = beginDoneFence(started.requestId, started.controller);
		expect(started.controller.signal.aborted).toBe(true);
		expect(mismatched.joined).toBe(false);
		expect(acceptSettledPrepare(started.requestId, mismatched.requestId)).toBe(
			false,
		);
		const matching = nextSettlePrepare(null, 0);
		const joined = beginDoneFence(matching.requestId, matching.controller, {
			join: true,
		});
		expect(matching.controller.signal.aborted).toBe(false);
		expect(joined.joined).toBe(true);
		expect(joined.controller).toBe(matching.controller);
		expect(acceptSettledPrepare(matching.requestId, joined.requestId)).toBe(
			false,
		);
	});

	it("starts prepare on pointerdown only when none is ready or in flight", () => {
		expect(SETTLE_PREPARE_DEBOUNCE_MS).toBe(150);
		expect(
			shouldJoinInflightPrepare({
				inflightMatches: true,
				sent: true,
				aborted: false,
			}),
		).toBe(true);
		expect(
			shouldJoinInflightPrepare({
				inflightMatches: false,
				sent: true,
				aborted: false,
			}),
		).toBe(false);
		expect(
			shouldStartPrepareOnPointerDown({
				sameSpec: true,
				ready: true,
				sent: true,
				aborted: false,
			}),
		).toBe(false);
		expect(
			shouldStartPrepareOnPointerDown({
				sameSpec: true,
				ready: false,
				sent: true,
				aborted: false,
			}),
		).toBe(false);
		expect(
			shouldStartPrepareOnPointerDown({
				sameSpec: false,
				ready: false,
				sent: false,
				aborted: false,
			}),
		).toBe(true);
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

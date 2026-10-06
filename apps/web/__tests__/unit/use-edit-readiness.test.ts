// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../actions/videos/get-edit-readiness", () => ({
	getEditReadiness: mocks.read,
}));

import { useEditReadiness } from "../../hooks/use-edit-readiness";
import { deriveEditReadiness } from "../../lib/video-edit-readiness";

let root: Root;
let element: HTMLDivElement;
let current: ReturnType<typeof useEditReadiness>;
function Harness({
	id = "video",
	context = "first",
	enabled = true,
}: {
	id?: string;
	context?: string;
	enabled?: boolean;
}) {
	current = useEditReadiness(id as never, enabled, context);
	return createElement(
		"span",
		null,
		current.readiness?.videoId ?? current.message,
	);
}
const ready = (id = "video", status: string | null = "PROCESSING") => ({
	status: "ready",
	readiness: deriveEditReadiness({
		videoId: id,
		identity: id,
		eligible: true,
		isPro: true,
		playbackAdmission: true,
		videoState: "processed",
		transcriptionStatus: status,
		transcriptRead: status === "COMPLETE" ? "ready" : "unavailable",
	}),
});
beforeEach(() => {
	vi.useFakeTimers();
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	element = document.createElement("div");
	root = createRoot(element);
	mocks.read.mockResolvedValue(ready());
});
afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
});
async function render(props = {}) {
	await act(async () => root.render(createElement(Harness, props)));
}

describe("serialized read-only polling", () => {
	it("does not read for nonowners/disabled consumers", async () => {
		await render({ enabled: false });
		expect(mocks.read).not.toHaveBeenCalled();
	});
	it("observes pending to usable COMPLETE without a navigation", async () => {
		await render();
		expect(current.readiness?.transcriptUsable).toBe(false);
		mocks.read.mockResolvedValue(ready("video", "COMPLETE"));
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(current.readiness?.transcriptUsable).toBe(true);
	});
	it("observes null to PROCESSING to COMPLETE without provider mutations", async () => {
		mocks.read
			.mockResolvedValueOnce(ready("video", null))
			.mockResolvedValueOnce(ready())
			.mockResolvedValue(ready("video", "COMPLETE"));
		await render();
		expect(current.readiness?.transcriptLabel).toBe("Transcript not started");
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(current.readiness?.transcriptLabel).toBe("Transcribing");
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(current.readiness?.transcriptUsable).toBe(true);
		await act(async () => vi.advanceTimersByTimeAsync(3600000));
		expect(mocks.read).toHaveBeenCalledTimes(3);
	});
	it("caps null observation honestly and Check again only reads", async () => {
		mocks.read.mockResolvedValue(ready("video", null));
		await render();
		await act(async () => vi.advanceTimersByTimeAsync(3600000));
		expect(mocks.read).toHaveBeenCalledTimes(12);
		expect(current.readiness?.transcriptLabel).toBe("Transcript not started");
		expect(current.readiness?.transcriptUsable).toBe(false);
		expect(current.message).toBe(
			"Transcript not started. Check again for an update.",
		);
		await act(async () => current.checkAgain());
		expect(mocks.read).toHaveBeenCalledTimes(13);
	});
	it("does not poll disabled transcript capability", async () => {
		mocks.read.mockResolvedValue(ready("video", "UNAVAILABLE"));
		await render();
		await act(async () => vi.advanceTimersByTimeAsync(3600000));
		expect(mocks.read).toHaveBeenCalledTimes(1);
	});
	it("cancels null follow-up on context change and unmount", async () => {
		mocks.read.mockResolvedValue(ready("video", null));
		await render();
		mocks.read.mockResolvedValue(ready("video", "COMPLETE"));
		await render({ context: "new" });
		await act(async () => vi.advanceTimersByTimeAsync(3600000));
		expect(mocks.read).toHaveBeenCalledTimes(2);
		mocks.read.mockResolvedValue(ready("video", null));
		await render({ context: "last" });
		await act(async () => root.render(null));
		await act(async () => vi.advanceTimersByTimeAsync(3600000));
		expect(mocks.read).toHaveBeenCalledTimes(3);
	});
	it("keeps null follow-up singleflight across manual checks", async () => {
		let resolve: (value: unknown) => void = () => {};
		mocks.read
			.mockResolvedValueOnce(ready("video", null))
			.mockImplementationOnce(
				() =>
					new Promise((done) => {
						resolve = done;
					}),
			);
		await render();
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		await act(async () => current.checkAgain());
		expect(mocks.read).toHaveBeenCalledTimes(2);
		mocks.read.mockResolvedValue(ready("video", "COMPLETE"));
		await act(async () => resolve(ready("video", null)));
		expect(mocks.read).toHaveBeenCalledTimes(3);
		expect(current.readiness?.transcriptUsable).toBe(true);
	});
	it("ignores stale video responses and serializes even across a switch", async () => {
		let resolve: (value: unknown) => void = () => {};
		mocks.read.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await render({ id: "old" });
		await render({ id: "new" });
		expect(current.readiness).toBeNull();
		expect(mocks.read).toHaveBeenCalledTimes(1);
		mocks.read.mockResolvedValue(ready("new", "COMPLETE"));
		await act(async () => resolve(ready("old", "COMPLETE")));
		expect(current.readiness?.videoId).toBe("new");
		expect(mocks.read).toHaveBeenCalledTimes(2);
	});
	it("invalidates previously usable controls on context/retry changes", async () => {
		mocks.read.mockResolvedValue(ready("video", "COMPLETE"));
		await render();
		mocks.read.mockResolvedValue(ready("video", null));
		await render({ context: "retry" });
		expect(current.readiness?.transcriptUsable).toBe(false);
	});
	it("reports errors without retaining usable controls", async () => {
		mocks.read.mockRejectedValue(new Error("private details"));
		await render();
		expect(current.readiness).toBeNull();
		expect(current.message).toBe("Unable to check readiness");
		expect(element.textContent).not.toContain("private details");
	});
	it("retries a transient unavailable result until a later read is ready", async () => {
		mocks.read
			.mockResolvedValueOnce({ status: "unavailable" })
			.mockResolvedValue(ready("video", "NO_AUDIO"));
		await render();
		expect(mocks.read).toHaveBeenCalledTimes(1);
		expect(current.readiness).toBeNull();
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(mocks.read).toHaveBeenCalledTimes(2);
		expect(current.readiness?.videoId).toBe("video");
		expect(current.readiness?.manualEditing).toBe(true);
		await act(async () => vi.advanceTimersByTimeAsync(3600000));
		expect(mocks.read).toHaveBeenCalledTimes(2);
	});
	it("retries a thrown read on the same bounded schedule without exposing the error", async () => {
		mocks.read
			.mockRejectedValueOnce(new Error("private details"))
			.mockResolvedValue(ready("video", "NO_AUDIO"));
		await render();
		expect(current.message).toBe("Unable to check readiness");
		expect(element.textContent).not.toContain("private details");
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(mocks.read).toHaveBeenCalledTimes(2);
		expect(current.readiness?.manualEditing).toBe(true);
	});
	it("stops unavailable retries at the existing attempt cap and starts a new cycle on Check again", async () => {
		mocks.read.mockResolvedValue({ status: "unavailable" });
		await render();
		await act(async () => vi.advanceTimersByTimeAsync(3600000));
		expect(mocks.read).toHaveBeenCalledTimes(12);
		expect(current.readiness).toBeNull();
		expect(current.message).toBe("Unable to check readiness");
		await act(async () => current.checkAgain());
		expect(mocks.read).toHaveBeenCalledTimes(13);
	});
	it("does not overlap or continue unavailable retries after disable, unmount, or a video switch", async () => {
		let resolve: (value: unknown) => void = () => {};
		mocks.read.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await render();
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(mocks.read).toHaveBeenCalledTimes(1);
		await act(async () => resolve({ status: "unavailable" }));
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(mocks.read).toHaveBeenCalledTimes(2);
		await render({ enabled: false });
		await act(async () => vi.advanceTimersByTimeAsync(3600000));
		expect(mocks.read).toHaveBeenCalledTimes(2);
		mocks.read.mockResolvedValue({ status: "unavailable" });
		await render();
		await act(async () => root.render(null));
		await act(async () => vi.advanceTimersByTimeAsync(3600000));
		expect(mocks.read).toHaveBeenCalledTimes(3);
		let late: (value: unknown) => void = () => {};
		mocks.read.mockImplementationOnce(
			() =>
				new Promise((done) => {
					late = done;
				}),
		);
		await render({ id: "old" });
		await render({ id: "new" });
		mocks.read.mockResolvedValue(ready("new", "NO_AUDIO"));
		await act(async () => late({ status: "unavailable" }));
		await act(async () => vi.advanceTimersByTimeAsync(3600000));
		expect(current.readiness?.videoId).toBe("new");
		expect(element.textContent).not.toContain("old");
	});
	it("does not admit a wrong-video response while retrying", async () => {
		mocks.read
			.mockResolvedValueOnce(ready("other", "COMPLETE"))
			.mockResolvedValue(ready("video", "NO_AUDIO"));
		await render();
		expect(current.readiness).toBeNull();
		await act(async () => vi.advanceTimersByTimeAsync(5000));
		expect(current.readiness?.videoId).toBe("video");
		expect(current.readiness?.manualEditing).toBe(true);
	});
	it("bounds automatic polling and leaves manual check available", async () => {
		await render();
		await act(async () => vi.advanceTimersByTimeAsync(3600000));
		expect(mocks.read).toHaveBeenCalledTimes(12);
		expect(current.message).toBe("Still preparing. Check again for an update.");
		await act(async () => current.checkAgain());
		expect(mocks.read).toHaveBeenCalledTimes(13);
	});
});

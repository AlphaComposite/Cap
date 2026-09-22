import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	recoverFailed: vi.fn(),
	recoverStalled: vi.fn(),
	cleanupBudgets: vi.fn(),
}));

vi.mock("@/lib/video-processing-recovery", () => ({
	recoverFailedVideoProcessing: mocks.recoverFailed,
}));
vi.mock("@/lib/video-pipeline-recovery", () => ({
	recoverStalledVideoPipeline: mocks.recoverStalled,
}));
vi.mock("@/lib/media-processing-budget", () => ({
	cleanupExpiredMediaProcessingBudgets: mocks.cleanupBudgets,
}));

import { GET } from "@/app/api/cron/recover-failed-video-processing/route";

const url = "http://localhost/api/cron/recover-failed-video-processing";

function request(token?: string) {
	return new Request(url, {
		headers: token ? { authorization: `Bearer ${token}` } : undefined,
	});
}

beforeEach(() => {
	vi.unstubAllEnvs();
	mocks.recoverFailed.mockResolvedValue({
		checked: 1,
		statuses: { started: 1 },
		results: [],
	});
	mocks.recoverStalled.mockResolvedValue({
		media: { checked: 0, statuses: {}, results: [] },
		transcription: { checked: 0, statuses: {}, results: [] },
		ai: { checked: 0, statuses: {}, results: [] },
	});
	mocks.cleanupBudgets.mockResolvedValue(0);
});

afterEach(() => vi.unstubAllEnvs());

describe("failed video processing recovery cron authentication", () => {
	it("fails closed when CRON_SECRET is missing", async () => {
		const response = await GET(request());

		expect(response.status).toBe(500);
		expect(mocks.recoverFailed).not.toHaveBeenCalled();
		expect(mocks.recoverStalled).not.toHaveBeenCalled();
	});

	it("rejects an incorrect bearer secret without running recovery", async () => {
		vi.stubEnv("CRON_SECRET", "test-cron-secret");

		const response = await GET(request("incorrect-secret"));

		expect(response.status).toBe(401);
		expect(mocks.recoverFailed).not.toHaveBeenCalled();
		expect(mocks.recoverStalled).not.toHaveBeenCalled();
	});

	it("runs the established recovery paths with the correct test secret", async () => {
		vi.stubEnv("CRON_SECRET", "test-cron-secret");

		const response = await GET(request("test-cron-secret"));

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			checked: 1,
			statuses: { started: 1 },
		});
		expect(mocks.recoverFailed).toHaveBeenCalledOnce();
		expect(mocks.recoverStalled).toHaveBeenCalledOnce();
		expect(mocks.cleanupBudgets).toHaveBeenCalledOnce();
	});

	it("terminalizes expired final claims before scanning stalled processing", async () => {
		vi.stubEnv("CRON_SECRET", "test-cron-secret");
		let releaseFinalizer: (() => void) | undefined;
		mocks.recoverFailed.mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseFinalizer = () =>
						resolve({ checked: 0, statuses: {}, results: [] });
				}),
		);

		const responsePromise = GET(request("test-cron-secret"));
		await vi.waitFor(() => expect(mocks.recoverFailed).toHaveBeenCalledOnce());
		expect(mocks.recoverStalled).not.toHaveBeenCalled();

		releaseFinalizer?.();
		const response = await responsePromise;
		expect(response.status).toBe(200);
		expect(mocks.recoverStalled).toHaveBeenCalledOnce();
	});
});

import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("@/lib/generate-ai", () => ({ startAiGeneration: vi.fn() }));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));
vi.mock("@/workflows/import-loom-video", () => ({}));
vi.mock("@/workflows/process-video", () => ({}));

const { aiRunNeedsRestart, AI_AUTO_RETRY_MAX, AI_RUN_STALE_MS } = await import(
	"@/lib/video-pipeline-recovery"
);

const now = new Date("2026-10-22T19:00:00Z");
const bootedAt = new Date("2026-10-22T18:50:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const base = { autoRetries: 0, bootedAt, now, updatedAt: ago(10_000) };

describe("aiRunNeedsRestart", () => {
	it("retries a failed run straight away", () => {
		expect(aiRunNeedsRestart({ ...base, status: "ERROR" })).toBe(true);
	});
	it("leaves a live, recently active run alone", () => {
		expect(aiRunNeedsRestart({ ...base, status: "PROCESSING" })).toBe(false);
		expect(aiRunNeedsRestart({ ...base, status: "QUEUED" })).toBe(false);
	});
	it("restarts a run that hung past the stale limit", () => {
		expect(
			aiRunNeedsRestart({
				...base,
				status: "PROCESSING",
				updatedAt: ago(AI_RUN_STALE_MS),
			}),
		).toBe(true);
	});
	it("restarts a run that a server restart killed, without waiting", () => {
		expect(
			aiRunNeedsRestart({
				...base,
				status: "PROCESSING",
				updatedAt: new Date(bootedAt.getTime() - 1000),
			}),
		).toBe(true);
	});
	it("stops after the retry cap so an outage can't loop", () => {
		expect(
			aiRunNeedsRestart({
				...base,
				status: "ERROR",
				autoRetries: AI_AUTO_RETRY_MAX,
			}),
		).toBe(false);
	});
	it("never touches finished or skipped runs", () => {
		for (const status of ["COMPLETE", "SKIPPED", undefined]) {
			expect(
				aiRunNeedsRestart({
					...base,
					status,
					updatedAt: ago(AI_RUN_STALE_MS * 10),
				}),
			).toBe(false);
		}
	});
});

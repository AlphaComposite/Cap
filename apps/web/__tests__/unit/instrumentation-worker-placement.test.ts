import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startWorker, database, origin } = vi.hoisted(() => ({
	startWorker: vi.fn(),
	database: {},
	origin: {},
}));

vi.mock("@cap/database/migrate", () => ({ migrateDb: vi.fn() }));
vi.mock("@cap/env", () => ({ buildEnv: vi.fn(), serverEnv: vi.fn() }));
vi.mock("@cap/database", () => ({ db: () => database }));
vi.mock("@/lib/revision-publication-origin", () => ({
	httpOriginClient: () => origin,
}));
vi.mock("@/lib/revision-publication", () => ({
	startRevisionReadbackWorker: startWorker,
}));
vi.mock("@/lib/instant-finish-source-relocate", () => ({
	reconcileOriginReadPolicy: vi.fn().mockResolvedValue(true),
}));

import { register } from "../../instrumentation.node";

describe("revision worker placement", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		vi.stubEnv("NEXT_PUBLIC_IS_CAP", "");
		vi.stubEnv("CAP_INSTANT_FINISH_ORIGIN_INTERNAL_URL", "http://origin:3020");
		vi.stubEnv("DATABASE_URL", "mysql://fixture@mysql/cap");
		vi.stubEnv("CAP_REVISION_WORKER_MODE", "");
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("keeps the existing in-process worker by default", async () => {
		await register();
		expect(startWorker).toHaveBeenCalledOnce();
		expect(startWorker).toHaveBeenCalledWith(
			expect.objectContaining({ database, origin, pollMs: 1500 }),
		);
	});

	it("does not start a competing consumer when an external worker is configured", async () => {
		vi.stubEnv("CAP_REVISION_WORKER_MODE", "external");
		await register();
		expect(startWorker).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(2);
	});
});

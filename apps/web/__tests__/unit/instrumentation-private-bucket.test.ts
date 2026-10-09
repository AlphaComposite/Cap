import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue({}) }));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => ({
	...(await importOriginal<typeof import("@aws-sdk/client-s3")>()),
	S3Client: class {
		send = mocks.send;
	},
}));
vi.mock("@cap/database/migrate", () => ({ migrateDb: vi.fn() }));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_DOCKER_BUILD: "false" },
	serverEnv: () => ({ CAP_AWS_BUCKET: "test-private-bucket" }),
}));

import { register } from "../../instrumentation.node";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it("creates a bucket without granting anonymous access", async () => {
	vi.useFakeTimers();
	vi.stubEnv("NEXT_PUBLIC_IS_CAP", "");
	vi.stubEnv("CAP_REVISION_WORKER_MODE", "external");
	vi.spyOn(console, "log").mockImplementation(() => {});
	await register();
	await vi.advanceTimersByTimeAsync(5000);
	expect(mocks.send).toHaveBeenCalledTimes(1);
	const command = mocks.send.mock.calls[0]?.[0];
	expect(command).toBeInstanceOf(CreateBucketCommand);
	expect(command.input).toEqual({ Bucket: "test-private-bucket" });
});

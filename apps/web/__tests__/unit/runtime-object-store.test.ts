import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({ serverEnv: () => ({ CAP_AWS_BUCKET: "test", CAP_AWS_REGION: "test", S3_INTERNAL_ENDPOINT: "https://storage.test", S3_PATH_STYLE: true }) }));
import { S3Client } from "@aws-sdk/client-s3";

import { runtimeObjectStore } from "@/lib/instant-finish-source-relocate";

it("reuses connections but performs each privacy inventory read", async () => {
	const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({ Contents: [], IsTruncated: false } as never);
	const first = runtimeObjectStore();
	const second = runtimeObjectStore();
	expect(second).toBe(first);
	await first.list?.("owner/video/");
	await second.list?.("owner/video/");
	expect(send).toHaveBeenCalledTimes(2);
	send.mockRestore();
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal("process", {
		...process,
		env: {
			NODE_ENV: "test",
			DATABASE_URL: "mysql://synthetic.invalid/test",
			WEB_URL: "https://synthetic.invalid",
			NEXTAUTH_SECRET: "synthetic-test-only",
			NEXTAUTH_URL: "https://synthetic.invalid",
			CAP_AWS_BUCKET: "synthetic",
			CAP_AWS_REGION: "synthetic",
		},
	});
});

afterEach(() => vi.unstubAllGlobals());

it.each([undefined, "false"])(
	"keeps speaker labels off for %s",
	async (value) => {
		if (value !== undefined) process.env.CAP_TRANSCRIPT_SPEAKER_LABELS = value;
		const { serverEnv } = await import("../../../../packages/env/server");
		expect(serverEnv().CAP_TRANSCRIPT_SPEAKER_LABELS).toBe(false);
	},
);

it("rejects activation until cross-run submission protection is approved", async () => {
	process.env.CAP_TRANSCRIPT_SPEAKER_LABELS = "true";
	vi.spyOn(console, "error").mockImplementation(() => {});
	const { serverEnv } = await import("../../../../packages/env/server");
	expect(() => serverEnv()).toThrow();
});

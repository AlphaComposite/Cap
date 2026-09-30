import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("editor join while prepare is pending", () => {
	it("refuses a job query error without a second relocation", async () => {
		process.env.MINIO_ROOT_USER = "capf8-root";
		process.env.MINIO_ROOT_PASSWORD = "not-used";
		process.env.CAP_AWS_ENDPOINT = "http://127.0.0.1:39218";
		process.env.CAP_AWS_BUCKET = "capf8";
		process.env.CAP_AWS_REGION = "us-east-1";
		process.env.DATABASE_URL ??= "mysql://127.0.0.1:36158/capv57";
		process.env.WEB_URL ??= "http://127.0.0.1:32120";
		process.env.NEXTAUTH_URL ??= "http://127.0.0.1:32120";
		process.env.NEXTAUTH_SECRET ??= "x".repeat(32);
		process.env.ORIGIN_S3_ACCESS_KEY = "origin-reader";
		vi.resetModules();
		const relocate = vi.fn(async () => ({
			liveKey: "private/source/vid/guessed",
			sha256: "abc",
		}));
		const prepare = vi.fn(async () => {
			throw new Error("prepare must not run");
		});
		const { openInstantFinishEditor } = await import(
			"@/lib/revision-publication-read"
		);
		let calls = 0;
		const database = {
			select: () => ({
				from: () => ({
					where: () => {
						calls += 1;
						if (calls >= 4) {
							return Promise.reject(new Error("outbox select failed"));
						}
						return Promise.resolve([
							{
								ownerId: "owner",
								liveKey: "owner/vidjoin0000001/result.mp4",
							},
						]);
					},
				}),
			}),
		};
		await expect(
			openInstantFinishEditor("vidjoin0000001", database, {
				actionRefresh: false,
				relocate,
				prepare,
			}),
		).rejects.toThrow(/retry/i);
		expect(relocate).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
	});

	it("does not relocate while a healthy prepare job is still pending", async () => {
		process.env.MINIO_ROOT_USER = "capf8-root";
		process.env.MINIO_ROOT_PASSWORD = "not-used";
		process.env.CAP_AWS_ENDPOINT = "http://127.0.0.1:39218";
		process.env.CAP_AWS_BUCKET = "capf8";
		process.env.CAP_AWS_REGION = "us-east-1";
		process.env.DATABASE_URL ??= "mysql://127.0.0.1:36158/capv57";
		process.env.WEB_URL ??= "http://127.0.0.1:32120";
		process.env.NEXTAUTH_URL ??= "http://127.0.0.1:32120";
		process.env.NEXTAUTH_SECRET ??= "x".repeat(32);
		vi.resetModules();
		const relocate = vi.fn(async () => ({
			liveKey: "private/source/vid/guessed",
			sha256: "abc",
		}));
		const prepare = vi.fn();
		const { openInstantFinishEditor } = await import(
			"@/lib/revision-publication-read"
		);
		let calls = 0;
		const database = {
			select: () => ({
				from: () => ({
					where: async () => {
						calls += 1;
						if (calls === 4) {
							return [
								{
									job: "source-prepare",
									payload: { finished: false, exhausted: false },
								},
							];
						}
						return [
							{
								ownerId: "owner",
								liveKey: "owner/vidjoin0000001/result.mp4",
								relocationState: "LIVE",
							},
						];
					},
				}),
			}),
		};
		await expect(
			openInstantFinishEditor("vidjoin0000001", database, {
				actionRefresh: false,
				relocate,
				prepare,
				stageWaitMs: 0,
			}),
		).rejects.toThrow(/retry/i);
		expect(relocate).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
	});
});

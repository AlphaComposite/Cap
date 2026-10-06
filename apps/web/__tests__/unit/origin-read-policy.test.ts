import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const calls: string[][] = [];
let createFailures = 0;

vi.mock("node:child_process", () => ({
	spawn: (_cmd: string, args: string[]) => {
		calls.push(args);
		let code = 0;
		const script = args.find((arg) => arg.includes("mc admin policy create"));
		if ((args.includes("create") || script) && createFailures > 0) {
			createFailures -= 1;
			code = script ? 10 : 1;
		}
		return {
			on(event: string, cb: (code: number) => void) {
				if (event === "close") queueMicrotask(() => cb(code));
				return this;
			},
		};
	},
}));

function policyCommands() {
	return calls.map(
		(args) =>
			args.find((arg) => ["create", "rm", "attach", "detach"].includes(arg)) ??
			"",
	);
}

function fakeDb() {
	const row = {
		ownerId: "owner",
		liveKey: "private/source/vid/a.mp4",
		sha256: "abc",
		relocationState: "PURGED",
		generation: 1,
		draftSession: "draft",
	};
	const query = Object.assign(Promise.resolve([row]), {
		from: () => query,
		where: () => query,
		set: () => query,
		values: () => query,
		onDuplicateKeyUpdate: () => Promise.resolve(),
	});
	return {
		select: () => query,
		insert: () => query,
		update: () => query,
	};
}

describe("origin read policy off the editor path", () => {
	beforeEach(() => {
		calls.length = 0;
		createFailures = 0;
		process.env.MINIO_ROOT_USER = "capf8-root";
		process.env.MINIO_ROOT_PASSWORD = "not-used";
		process.env.CAP_AWS_ENDPOINT = "http://127.0.0.1:39218";
		process.env.CAP_AWS_BUCKET = "capf8";
		process.env.CAP_AWS_REGION = "us-east-1";
		process.env.DATABASE_URL ??= "mysql://127.0.0.1:33181/capf8";
		process.env.WEB_URL ??= "http://127.0.0.1:32120";
		process.env.NEXTAUTH_URL ??= "http://127.0.0.1:32120";
		process.env.NEXTAUTH_SECRET ??= "x".repeat(32);
		process.env.ORIGIN_S3_ACCESS_KEY = "origin-reader";
	});

	it("does not spawn a policy refresh from openInstantFinishEditor", async () => {
		vi.resetModules();
		const { openInstantFinishEditor } = await import(
			"@/lib/revision-publication-read"
		);
		await openInstantFinishEditor("vid", fakeDb(), {
			actionRefresh: false,
			relocate: async () => ({
				liveKey: "private/source/vid/a.mp4",
				sha256: "abc",
			}),
			prepare: async () => ({
				sourceKey: "private/source/vid/a.mp4",
				sha256: "abc",
				codec: "avc1",
				timebase: "1/30",
				frameMode: "cfr" as const,
				a1Digest: "digest",
				indexId: "index",
				warmExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			}),
		});
		expect(calls.some((args) => args[0] === "run")).toBe(false);
	});

	it("does not remove a policy before the replacement is attached", async () => {
		createFailures = 1;
		vi.resetModules();
		const { refreshOriginReadPolicy } = await import(
			"@/lib/instant-finish-source-relocate"
		);
		await refreshOriginReadPolicy(
			fakeDb() as never,
			"private/source/vid/a.mp4",
		).catch(() => undefined);
		const commands = policyCommands();
		const removed = commands.indexOf("rm");
		const attached = commands.indexOf("attach");
		expect(removed === -1 || (attached !== -1 && attached < removed)).toBe(
			true,
		);
	});

	it("creates then attaches in one mc container, args passed positionally", async () => {
		vi.resetModules();
		const { refreshOriginReadPolicy } = await import(
			"@/lib/instant-finish-source-relocate"
		);
		await refreshOriginReadPolicy(fakeDb() as never, "private/source/vid/a.mp4");
		const runs = calls.filter((args) => args[0] === "run");
		expect(runs).toHaveLength(1);
		const script = runs[0]!.find((arg) => arg.includes("mc admin policy create"));
		expect(script).toBeDefined();
		expect(script).toContain("mc admin policy attach");
		// Name and user are never interpolated into the shell script.
		expect(script).not.toContain("origin-reader");
		expect(runs[0]!.slice(-2)).toEqual([expect.any(String), "origin-reader"]);
	});

	it("rejects and never attaches when create fails", async () => {
		createFailures = 1;
		vi.resetModules();
		const { refreshOriginReadPolicy } = await import(
			"@/lib/instant-finish-source-relocate"
		);
		await expect(
			refreshOriginReadPolicy(fakeDb() as never, "private/source/vid/a.mp4"),
		).rejects.toThrow("Origin read policy was not updated");
		expect(calls.filter((args) => args[0] === "run")).toHaveLength(1);
	});
});

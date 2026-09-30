import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const policies: string[] = [];

vi.mock("node:child_process", () => ({
	spawn: () => ({
		on(event: string, cb: (code: number) => void) {
			if (event === "close") queueMicrotask(() => cb(0));
			return this;
		},
	}),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		writeFile: async (
			path: string,
			data: string | Buffer,
			options?: Parameters<typeof actual.writeFile>[2],
		) => {
			if (String(path).endsWith("policy.json")) policies.push(String(data));
			return actual.writeFile(path, data, options);
		},
	};
});

const sha = "a".repeat(64);
const otherSha = "b".repeat(64);
const registeredRollback = "private/rollback/vid-a/kept.mp4";
const registeredPrivate = "private/source/vid-b/live.mp4";
const staged = "private/source/vid-a/staged.mp4";
const injected = "private/source/vid-a/injected.mp4";
const unbound = "private/source/vid-x/stolen.mp4";
const cross = "private/source/vid-c/cross.mp4";
const mismatched = "private/source/vid-a/mismatch.mp4";
const stale = "private/source/vid-a/stale.mp4";
const deleted = "private/source/vid-a/deleted.mp4";
const aborted = "private/source/vid-a/aborted.mp4";
const intent = "private/source/vid-a/intent.mp4";
const wildcard = "private/source/vid-a/*";

const sources = [
	{
		videoId: "vid-a",
		liveKey: registeredRollback,
		sha256: sha,
		relocationState: "LIVE",
	},
	{
		videoId: "vid-b",
		liveKey: registeredPrivate,
		sha256: otherSha,
		relocationState: "PURGED",
	},
];

const stages = [
	{
		videoId: "vid-a",
		oldKey: registeredRollback,
		newKey: staged,
		sha256: sha,
		state: "COPIED",
	},
	{
		videoId: "vid-x",
		oldKey: "missing",
		newKey: unbound,
		sha256: sha,
		state: "COPIED",
	},
	{
		videoId: "vid-c",
		oldKey: "owner/vid-c/result.mp4",
		newKey: cross,
		sha256: sha,
		state: "COPIED",
	},
	{
		videoId: "vid-a",
		oldKey: registeredRollback,
		newKey: mismatched,
		sha256: otherSha,
		state: "COPIED",
	},
	{
		videoId: "vid-a",
		oldKey: "owner/vid-a/old.mp4",
		newKey: stale,
		sha256: sha,
		state: "COPIED",
	},
	{
		videoId: "vid-a",
		oldKey: registeredRollback,
		newKey: deleted,
		sha256: sha,
		state: "DELETED",
	},
	{
		videoId: "vid-a",
		oldKey: registeredRollback,
		newKey: aborted,
		sha256: sha,
		state: "ABORTED",
	},
	{
		videoId: "vid-a",
		oldKey: registeredRollback,
		newKey: intent,
		sha256: sha,
		state: "INTENT",
	},
	{
		videoId: "vid-a",
		oldKey: registeredRollback,
		newKey: wildcard,
		sha256: sha,
		state: "POINTER",
	},
];

function policyDb(sourceRows = sources, stageRows = stages) {
	let reads = 0;
	return {
		select: () => ({
			from: () => {
				reads += 1;
				return Promise.resolve(reads % 2 === 1 ? sourceRows : stageRows);
			},
		}),
	};
}

function grantedKeys(document: string | undefined) {
	const parsed = JSON.parse(document ?? '{"Statement":[]}') as {
		Statement?: Array<{ Resource?: string[] }>;
	};
	const resources =
		parsed.Statement?.flatMap((item) => item.Resource ?? []) ?? [];
	return resources
		.map((resource) => {
			const index = resource.indexOf("private/");
			return index === -1 ? "" : resource.slice(index);
		})
		.filter((key) => key.length > 0)
		.sort();
}

describe("recorded origin read keys", () => {
	beforeEach(() => {
		policies.length = 0;
		vi.resetModules();
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

	it("grants only the joined stage and registered private live keys", async () => {
		const { refreshOriginReadPolicy, reconcileOriginReadPolicy } = await import(
			"@/lib/instant-finish-source-relocate"
		);
		await refreshOriginReadPolicy(policyDb() as never, injected);
		await reconcileOriginReadPolicy(policyDb() as never);
		const expected = [registeredRollback, registeredPrivate, staged].sort();
		expect(grantedKeys(policies[0])).toEqual(expected);
		expect(grantedKeys(policies[1])).toEqual(expected);
		expect(grantedKeys(policies[0])).not.toContain(injected);
		expect(grantedKeys(policies[0])).not.toContain(unbound);
		expect(grantedKeys(policies[0])).not.toContain(cross);
		expect(grantedKeys(policies[0])).not.toContain(mismatched);
		expect(grantedKeys(policies[0])).not.toContain(stale);
		expect(grantedKeys(policies[0])).not.toContain(deleted);
		expect(grantedKeys(policies[0])).not.toContain(aborted);
		expect(grantedKeys(policies[0])).not.toContain(wildcard);
	});

	it("drops a formerly legitimate stage after it is aborted", async () => {
		const { reconcileOriginReadPolicy } = await import(
			"@/lib/instant-finish-source-relocate"
		);
		const liveStages = stages.map((row) => ({ ...row }));
		await reconcileOriginReadPolicy(policyDb(sources, liveStages) as never);
		expect(grantedKeys(policies.at(-1))).toContain(staged);
		liveStages[0] = { ...liveStages[0]!, state: "ABORTED" };
		await reconcileOriginReadPolicy(policyDb(sources, liveStages) as never);
		expect(grantedKeys(policies.at(-1))).not.toContain(staged);
		expect(grantedKeys(policies.at(-1))).toContain(registeredRollback);
	});
});

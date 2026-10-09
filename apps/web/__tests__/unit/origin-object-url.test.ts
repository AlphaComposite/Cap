import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { resolve } from "node:path";
import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as serviceAuth from "@/lib/revision-media-token";
import {
	ORIGIN_SERVICE_HEADER,
	signInternalServiceRequest,
	verifyInternalServiceRequest,
} from "@/lib/revision-media-token";

const state = vi.hoisted(() => ({
	sources: [] as Array<{
		videoId: string;
		liveKey: string;
		sha256: string;
		relocationState: string;
	}>,
	stages: [] as Array<{
		videoId: string;
		oldKey: string;
		newKey: string;
		sha256: string;
		state: string;
	}>,
	reads: 0,
	select: vi.fn(),
	get: vi.fn(),
	head: vi.fn(),
	bucket: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({ db: () => ({ select: state.select }) }));
vi.mock("@cap/web-backend", () => ({
	S3Buckets: { getBucketAccess: state.bucket },
}));
vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));

import { POST } from "@/app/api/internal/origin/object-url/route";
import {
	reconcileOriginReadPolicy,
	refreshOriginReadPolicy,
} from "@/lib/instant-finish-source-relocate";

const path = "/api/internal/origin/object-url";
const key = "private/source/vid/original.mp4";
const sha = "a".repeat(64);
function request(
	value: unknown,
	audience: "web-object-url" | "origin-service" = "web-object-url",
	token?: string,
) {
	const body = JSON.stringify({ key: value });
	return new Request(`http://cap-web:3000${path}`, {
		method: "POST",
		body,
		headers: {
			[ORIGIN_SERVICE_HEADER]:
				token ??
				signInternalServiceRequest({ method: "POST", path, body, audience }),
		},
	});
}

beforeEach(() => {
	vi.stubEnv(
		"REVISION_ORIGIN_SERVICE_SECRET",
		"test-only-service-secret".repeat(2),
	);
	state.sources = [
		{ videoId: "vid", liveKey: key, sha256: sha, relocationState: "LIVE" },
	];
	state.stages = [];
	state.reads = 0;
	state.select.mockReset().mockImplementation(() => ({
		from: () =>
			Promise.resolve(++state.reads % 2 ? state.sources : state.stages),
	}));
	state.get
		.mockReset()
		.mockReturnValue(Effect.succeed("http://storage/get-signed"));
	state.head
		.mockReset()
		.mockReturnValue(Effect.succeed("http://storage/head-signed"));
	state.bucket.mockReset().mockReturnValue(
		Effect.succeed([
			{
				getInternalSignedObjectUrl: state.get,
				getInternalSignedHeadUrl: state.head,
			},
		]),
	);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("origin exact object URLs", () => {
	it("accepts the Python origin's reverse-direction MAC", async () => {
		const body = JSON.stringify({ key });
		const token = execFileSync(
			"python3",
			[
				"-c",
				"import sys; from service_auth import sign_request; print(sign_request(sys.argv[1].encode(), 'POST', sys.argv[2], sys.argv[3].encode(), audience='web-object-url'))",
				process.env.REVISION_ORIGIN_SERVICE_SECRET ?? "",
				path,
				body,
			],
			{
				cwd: resolve(process.cwd(), "../instant-finish-origin"),
				env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
				encoding: "utf8",
			},
		).trim();
		expect((await POST(request(key, "web-object-url", token))).status).toBe(
			200,
		);
	});
	it("allows a recorded exact key with internal GET/HEAD, default bucket, short TTL and no cache", async () => {
		const response = await POST(request(key));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			getUrl: "http://storage/get-signed",
			headUrl: "http://storage/head-signed",
			expiresIn: 300,
		});
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(state.bucket).toHaveBeenCalledWith(Option.none());
		expect(state.get).toHaveBeenCalledWith(key, { expiresIn: 300 });
		expect(state.head).toHaveBeenCalledWith(key, { expiresIn: 300 });
	});
	it("shares registered rollback and admitted stage keys, excluding stale or unbound stages", async () => {
		const rollback = "private/rollback/vid/old.mp4";
		state.sources = [
			{
				videoId: "vid",
				liveKey: rollback,
				sha256: sha,
				relocationState: "LIVE",
			},
		];
		state.stages = [
			{
				videoId: "vid",
				oldKey: rollback,
				newKey: key,
				sha256: sha,
				state: "COPIED",
			},
			{
				videoId: "vid",
				oldKey: key,
				newKey: "private/source/vid/stale.mp4",
				sha256: sha,
				state: "COPIED",
			},
		];
		expect((await POST(request(rollback))).status).toBe(200);
		expect((await POST(request(key))).status).toBe(200);
		expect((await POST(request("private/source/vid/stale.mp4"))).status).toBe(
			403,
		);
	});
	it.each([
		"private/source/vid/missing.mp4",
		"private/source/vid/",
		"private/source/vid/*",
		"private/source/vid/a?",
		"private/source/vid/../original.mp4",
		"/private/source/vid/original.mp4",
		"owner/vid/result.mp4",
		null,
	])(
		"denies non-exact or unsafe key %s without signing and logs only videoId",
		async (value) => {
			if (typeof value === "string" && /[*?]|\.\.|^\/|^owner\//.test(value)) {
				state.sources.push({
					videoId: "vid",
					liveKey: value,
					sha256: sha,
					relocationState: "LIVE",
				});
			}
			expect((await POST(request(value))).status).toBe(403);
			expect(state.bucket).not.toHaveBeenCalled();
			expect(console.warn).toHaveBeenCalledWith("origin object URL denied", {
				videoId:
					typeof value === "string" &&
					/^[A-Za-z0-9_-]{1,128}$/.test(value.split("/")[2] ?? "")
						? value.split("/")[2]
						: null,
			});
		},
	);
	it.each(["missing", "forged", "wrong-audience"])(
		"401s %s MAC before DB access",
		async (kind) => {
			const req = request(
				key,
				kind === "wrong-audience" ? "origin-service" : "web-object-url",
				kind === "forged" ? "forged.mac" : undefined,
			);
			if (kind === "missing") req.headers.delete(ORIGIN_SERVICE_HEADER);
			expect((await POST(req)).status).toBe(401);
			expect(state.select).not.toHaveBeenCalled();
			expect(state.bucket).not.toHaveBeenCalled();
		},
	);
	it("does not replay a reverse-direction token into the default origin audience", () => {
		const input = { method: "POST", path, body: "{}" };
		const token = signInternalServiceRequest({
			...input,
			audience: "web-object-url",
		});
		expect(verifyInternalServiceRequest(token, input)).toBe(false);
		expect(
			verifyInternalServiceRequest(token, {
				...input,
				audience: "web-object-url",
			}),
		).toBe(true);
	});
	it("consumes a nonce before DB awaits and rejects concurrent replay", async () => {
		const first = request(key);
		const token = first.headers.get(ORIGIN_SERVICE_HEADER) ?? "";
		const [a, b] = await Promise.all([
			POST(first),
			POST(request(key, "web-object-url", token)),
		]);
		expect([a.status, b.status].sort()).toEqual([200, 401]);
		expect(state.bucket).toHaveBeenCalledTimes(1);
		expect((await POST(request(key, "web-object-url", token))).status).toBe(
			401,
		);
		expect(state.bucket).toHaveBeenCalledTimes(1);
	});
	it("retains a consumed nonce through its valid TTL including future skew", async () => {
		const now = Math.floor(Date.now() / 1000);
		vi.spyOn(Date, "now").mockReturnValue(now * 1000);
		const token = signInternalServiceRequest({
			method: "POST",
			path,
			body: JSON.stringify({ key }),
			audience: "web-object-url",
			now: now + 5,
		});
		expect((await POST(request(key, "web-object-url", token))).status).toBe(
			200,
		);
		vi.mocked(Date.now).mockReturnValue((now + 35) * 1000);
		expect((await POST(request(key, "web-object-url", token))).status).toBe(
			401,
		);
		expect(state.bucket).toHaveBeenCalledTimes(1);
	});
	it("prunes consumed nonces only after expiry plus skew", async () => {
		const now = Math.floor(Date.now() / 1000);
		vi.spyOn(Date, "now").mockReturnValue(now * 1000);
		const first = request(key);
		const token = first.headers.get(ORIGIN_SERVICE_HEADER) ?? "";
		const claims = JSON.parse(
			Buffer.from(token.split(".")[0] ?? "", "base64url").toString(),
		);
		expect((await POST(first)).status).toBe(200);
		const body = JSON.stringify({ key });
		const refreshed = (time: number) => {
			const encoded = Buffer.from(
				JSON.stringify({ ...claims, iat: time, exp: time + 30 }),
			).toString("base64url");
			const hash = createHash("sha256").update(body).digest("hex");
			const mac = createHmac(
				"sha256",
				process.env.REVISION_ORIGIN_SERVICE_SECRET ?? "",
			)
				.update(`${encoded}.POST.${path}.${hash}`)
				.digest("base64url");
			return `${encoded}.${mac}`;
		};
		vi.mocked(Date.now).mockReturnValue((now + 35) * 1000);
		expect(
			(await POST(request(key, "web-object-url", refreshed(now + 35)))).status,
		).toBe(401);
		vi.mocked(Date.now).mockReturnValue((now + 36) * 1000);
		expect(
			(await POST(request(key, "web-object-url", refreshed(now + 36)))).status,
		).toBe(200);
	});
	it.each(["length", "chunked", "lying-length", "single-chunk"])(
		"rejects oversized %s bodies before MAC/DB and stops reading",
		async (kind) => {
			const verify = vi.spyOn(serviceAuth, "verifyInternalServiceRequest");
			let reads = 0;
			const cancel = vi.fn();
			const stream = new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						reads++;
						if (reads <= 2)
							controller.enqueue(
								new Uint8Array(kind === "single-chunk" ? 4097 : 4096),
							);
						else controller.close();
					},
					cancel,
				},
				{ highWaterMark: 0 },
			);
			const req = new Request(`http://cap-web:3000${path}`, {
				method: "POST",
				body: stream,
				headers:
					kind === "length"
						? { "Content-Length": "4097" }
						: kind === "lying-length"
							? { "Content-Length": "1" }
							: {},
				duplex: "half",
			} as RequestInit);
			expect((await POST(req)).status).toBe(413);
			expect(reads).toBe(
				kind === "length" ? 0 : kind === "single-chunk" ? 1 : 2,
			);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(verify).not.toHaveBeenCalled();
			expect(state.select).not.toHaveBeenCalled();
			expect(state.bucket).not.toHaveBeenCalled();
		},
	);
	it("accepts exactly 4 KiB and verifies the original UTF-8 bytes", async () => {
		const body = JSON.stringify({ key, ignored: "é" });
		const padded = body + " ".repeat(4096 - Buffer.byteLength(body));
		const bytes = Buffer.from(padded);
		const token = signInternalServiceRequest({
			method: "POST",
			path,
			body: bytes,
			audience: "web-object-url",
		});
		const req = new Request(`http://cap-web:3000${path}`, {
			method: "POST",
			body: bytes,
			headers: { [ORIGIN_SERVICE_HEADER]: token, "Content-Length": "4096" },
		});
		expect((await POST(req)).status).toBe(200);
	});
	it("fails closed if registration or signing fails", async () => {
		state.select.mockImplementationOnce(() => {
			throw new Error("db unavailable");
		});
		expect((await POST(request(key))).status).toBe(503);
		state.get.mockReturnValue(Effect.fail("unavailable"));
		expect((await POST(request(key))).status).toBe(503);
	});
	it("presign policy refresh/reconcile succeed without DB or mc/docker work", async () => {
		vi.stubEnv("ORIGIN_READ_MODE", "presign");
		const app = {
			select: () => {
				throw new Error("must not read policy DB");
			},
		};
		expect(await refreshOriginReadPolicy(app as never, key)).toBe(true);
		expect(await reconcileOriginReadPolicy(app as never)).toBe(true);
	});
});

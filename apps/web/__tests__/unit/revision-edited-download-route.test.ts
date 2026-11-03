import { Readable } from "node:stream";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	user: true,
	permitted: true,
	viewable: true,
	current: true,
	epoch: 3,
	race: false,
	calls: 0,
	receipt: true,
	original: false,
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}), buildEnv: {} }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => (state.user ? { id: "owner1234" } : null),
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		execute: async () =>
			state.current
				? [
						{
							ownerId: "owner1234",
							videoId: "video1234",
							revisionId: "revision1234",
							generation: 7,
							sourceId: "source1234",
							name: "edited",
							publicationEpoch: 2,
							policyEpoch: state.epoch,
							metadataSnapshot: {
								downloadArtifact: state.receipt
									? {
											validation: "verified",
											ownerId: "owner1234",
											videoId: "video1234",
											revisionId: "revision1234",
											generation: 7,
											sourceId: "source1234",
											namespace: Array(4).fill("a".repeat(64)).join("/"),
											bucket: "private",
											key: "owner1234/video1234/private/edited/revision1234/7/attempt.mp4",
											versionId: "version1",
											sha256: "b".repeat(64),
											size: 12,
										}
									: undefined,
							},
						},
					]
				: [],
	}),
}));
vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	return {
		VideosPolicy: Context.GenericTag("TestPolicy"),
		provideOptionalAuth: <T>(effect: T) => effect,
	};
});
vi.mock("@/lib/server", async () => {
	const { VideosPolicy } = await import("@cap/web-backend");
	return {
		apiToHandler: (api: Parameters<typeof HttpApiBuilder.toWebHandler>[0]) =>
			HttpApiBuilder.toWebHandler(
				api.pipe(
					Layer.provide(
						Layer.succeed(VideosPolicy, {
							getViewableById: () =>
								Effect.succeed(
									state.viewable ? Option.some({}) : Option.none(),
								),
						} as unknown as typeof VideosPolicy.Service),
					),
					Layer.merge(HttpServer.layerContext),
				),
			).handler,
	};
});
vi.mock("@/lib/video-download-permissions", () => ({
	canUserDownloadVideo: async () => state.permitted,
}));
vi.mock("@/lib/instant-finish-source-relocate", () => ({
	runtimeS3Client: () => ({
		send: async (command: unknown) => {
			state.calls += 1;
			if (state.race) state.epoch += 1;
			if (command instanceof HeadObjectCommand)
				return { VersionId: "version1", ContentLength: 12 };
			if (!(command instanceof GetObjectCommand))
				throw new Error("Unexpected operation");
			expect(command.input).toMatchObject({
				Bucket: "private",
				VersionId: "version1",
				Key: "owner1234/video1234/private/edited/revision1234/7/attempt.mp4",
			});
			const range = command.input.Range;
			const bytes = Buffer.from("edited-bytes");
			const body = Readable.from([range ? bytes.subarray(2, 5) : bytes]);
			return {
				VersionId: "version1",
				ContentLength: range ? 3 : 12,
				ContentRange: range ? "bytes 2-4/12" : undefined,
				$metadata: { httpStatusCode: range ? 206 : 200 },
				Body: Object.assign(body, {
					transformToWebStream: () => Readable.toWeb(body),
				}),
			};
		},
	}),
}));

import { GET, HEAD } from "@/app/api/video/edited-download/route";
import { signRevisionMediaGrant } from "@/lib/revision-media-token";

function request(
	options: {
		videoId?: string;
		artifact?: "download" | "playback";
		method?: string;
		range?: string;
	} = {},
) {
	const grant = signRevisionMediaGrant({
		videoId: "video1234",
		revisionId: "revision1234",
		publicationEpoch: 2,
		policyEpoch: 3,
		artifact: options.artifact === "playback" ? undefined : "download",
	});
	return new Request(
		`http://cap.test/api/video/edited-download?videoId=${options.videoId ?? "video1234"}&t=${grant}&key=original.mp4&versionId=attacker`,
		{
			method: options.method ?? "GET",
			headers: options.range ? { range: options.range } : undefined,
		},
	);
}

describe("edited-download actual HttpApi handler", () => {
	beforeEach(() => {
		Object.assign(state, {
			user: true,
			permitted: true,
			viewable: true,
			current: true,
			epoch: 3,
			race: false,
			calls: 0,
			receipt: true,
		});
		process.env.CAP_INSTANT_FINISH_OWNERS = "owner1234";
		process.env.REVISION_MEDIA_GRANT_KEYS =
			"k1:grant-secret-grant-secret-grant-01";
	});
	it("streams the trusted current receipt ignoring client storage identifiers", async () => {
		const response = await GET(request());
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("edited-bytes");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(state.calls).toBe(1);
	});
	it("authorizes HEAD and Range206/416 independently", async () => {
		const head = await HEAD(request({ method: "HEAD" }));
		expect(head.status).toBe(200);
		expect(head.body).toBeNull();
		const rangedHead = await HEAD(
			request({ method: "HEAD", range: "bytes=2-4" }),
		);
		expect(rangedHead.status).toBe(206);
		expect(rangedHead.headers.get("content-range")).toBe("bytes 2-4/12");
		expect(rangedHead.headers.get("content-length")).toBe("3");
		expect(rangedHead.body).toBeNull();
		const partial = await GET(request({ range: "bytes=2-4" }));
		expect(partial.status).toBe(206);
		expect(await partial.text()).toBe("ite");
		const rejected = await GET(request({ range: "bytes=100-" }));
		expect(rejected.status).toBe(416);
		expect(rejected.headers.get("cache-control")).toBe("private, no-store");
	});
	it.each([
		"anonymous",
		"permission",
		"policy",
		"revoked",
		"superseded",
		"missing-receipt",
	])(
		"denies %s without any original fallback or storage read",
		async (scenario) => {
			if (scenario === "anonymous") state.user = false;
			if (scenario === "permission") state.permitted = false;
			if (scenario === "policy") state.viewable = false;
			if (scenario === "revoked") state.epoch = 4;
			if (scenario === "superseded") state.current = false;
			if (scenario === "missing-receipt") state.receipt = false;
			const response = await GET(request());
			expect([401, 403, 410]).toContain(response.status);
			expect(state.calls).toBe(0);
			expect(response.headers.get("location")).toBeNull();
		},
	);
	it("rejects cross-video and playback-token download", async () => {
		for (const req of [
			request({ videoId: "another1234" }),
			request({ artifact: "playback" }),
		]) {
			expect((await GET(req)).status).toBe(403);
		}
		expect(state.calls).toBe(0);
	});
	it("rechecks epochs after storage awaits and cancels a revoked response", async () => {
		state.race = true;
		const response = await GET(request());
		expect(response.status).toBe(410);
		expect(await response.text()).toBe("");
	});
});

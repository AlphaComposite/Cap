import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	epoch: 3,
	reads: 0,
	storage: 0,
	corrupt: false,
	race: false,
	missing: false,
	partial: false,
	snapshotChanged: false,
	invalid: null as Record<string, unknown> | null,
	badSnapshot: undefined as unknown,
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}), buildEnv: {} }));
vi.mock("@/lib/server", () => ({
	apiToHandler: (api: Parameters<typeof HttpApiBuilder.toWebHandler>[0]) =>
		HttpApiBuilder.toWebHandler(api.pipe(Layer.merge(HttpServer.layerContext)))
			.handler,
}));
vi.mock("@cap/web-backend", () => ({
	VideosPolicy: class VideosPolicy {},
	provideOptionalAuth: <T>(effect: T) => effect,
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		execute: async () => {
			state.reads++;
			if (state.missing) return [];
			const artifacts = Object.fromEntries(
				names.map((name) => [
					name,
					{ ...member, key: `${prefix}${name.replaceAll("/", "-")}` },
				]),
			);
			if (state.partial) delete artifacts["init.mp4"];
			return [
				{
					...identity,
					publicationEpoch: 2,
					policyEpoch: state.epoch,
					name: "edited",
					metadataSnapshot: {
						...snapshot,
						captionsVtt: state.snapshotChanged
							? "changed"
							: snapshot.captionsVtt,
						downloadArtifact: {
							...member,
							...state.invalid,
							hls: {
								validation: "verified",
								snapshot:
									state.badSnapshot === undefined
										? snapshot
										: state.badSnapshot,
								artifacts,
							},
						},
					},
				},
			];
		},
	}),
}));
vi.mock("@/lib/instant-finish-source-relocate", () => ({
	runtimeS3Client: () => ({
		send: async (command: unknown) => {
			state.storage++;
			if (!(command instanceof GetObjectCommand))
				throw new Error("Unexpected command");
			expect(command.input.VersionId).toBe("pinned-version");
			expect(command.input.Key).toBe(`${prefix}seg-0.m4s`);
			if (state.race) state.epoch++;
			const body = Readable.from([
				state.corrupt ? Buffer.alloc(bytes.length) : bytes,
			]);
			return {
				VersionId: "pinned-version",
				ContentLength: bytes.length,
				$metadata: { httpStatusCode: 200 },
				Body: Object.assign(body, {
					transformToWebStream: () => Readable.toWeb(body),
				}),
			};
		},
	}),
}));

import { GET } from "@/app/api/internal/origin/revision-artifact/route";
import { signInternalServiceRequest } from "@/lib/revision-media-token";

const identity = {
	ownerId: "owner1234",
	videoId: "video1234",
	revisionId: "revision1234",
	sourceId: "source1234",
	generation: 7,
};
const prefix = "owner1234/video1234/private/edited/revision1234/7/";
const bytes = Buffer.from("exact-fragment-with-private-data");
const snapshot = { captionsVtt: "WEBVTT\n", chapters: [], thumbnailSha256: "" };
const member = {
	...identity,
	validation: "verified",
	bucket: "private",
	key: `${prefix}download.mp4`,
	versionId: "pinned-version",
	namespace: Array(4).fill("a".repeat(64)).join("/"),
	size: bytes.length,
	sha256: createHash("sha256").update(bytes).digest("hex"),
};
const names = [
	"playlist.m3u8",
	"init.mp4",
	"seg/0.m4s",
	"captions.vtt",
	"chapters.json",
	"thumbnail.jpg",
];
const path = "/api/internal/origin/revision-artifact";
function request(
	options: {
		audience?: "origin-service" | "web-object-url" | "web-revision-artifact";
		token?: boolean;
		revisionId?: string;
		name?: string;
		extra?: string;
	} = {},
) {
	const query = new URLSearchParams({
		videoId: identity.videoId,
		revisionId: options.revisionId ?? identity.revisionId,
		name: options.name ?? "seg/0.m4s",
	});
	const target = `${path}?${query}${options.extra ?? ""}`;
	return new Request(`http://cap.test${target}`, {
		headers:
			options.token === false
				? {}
				: {
						"x-cap-origin-service": signInternalServiceRequest({
							method: "GET",
							path: target,
							audience: options.audience ?? "web-revision-artifact",
						}),
					},
	});
}

describe("private exact revision artifact transport", () => {
	beforeEach(() => {
		Object.assign(state, {
			epoch: 3,
			reads: 0,
			storage: 0,
			corrupt: false,
			race: false,
			missing: false,
			partial: false,
			snapshotChanged: false,
			invalid: null,
			badSnapshot: undefined,
		});
		vi.stubEnv("REVISION_ORIGIN_SERVICE_SECRET", "s".repeat(32));
	});
	it("serves native-equal checksum-verified pinned bytes and no storage descriptor", async () => {
		const response = await GET(request());
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("x-cap-sha256")).toBe(member.sha256);
		expect([...response.headers.values()].join(" ")).not.toContain(prefix);
		expect(state.storage).toBe(1);
		expect(state.reads).toBe(2);
	});
	it.each(["origin-service", "web-object-url"] as const)(
		"rejects replay from %s audience before DB or storage",
		async (audience) => {
			expect((await GET(request({ audience }))).status).toBe(401);
			expect(state.reads).toBe(0);
			expect(state.storage).toBe(0);
		},
	);
	it("rejects unsigned requests", async () => {
		expect((await GET(request({ token: false }))).status).toBe(401);
		expect(state.reads).toBe(0);
	});
	it("consumes a signed request before storage and denies replay", async () => {
		const signed = request();
		expect((await GET(signed.clone())).status).toBe(200);
		expect((await GET(signed.clone())).status).toBe(401);
		expect(state.storage).toBe(1);
	});
	it("admits two Python signs in one second and denies replay of each", async () => {
		const unsigned = request();
		const target = new URL(unsigned.url);
		const tokens = JSON.parse(
			execFileSync(
				"python3",
				[
					"-c",
					"import json,sys; sys.path.insert(0,sys.argv[1]); import service_auth; print(json.dumps([service_auth.sign_request(b's'*32,'GET',sys.argv[2],now=int(sys.argv[3]),audience='web-revision-artifact') for _ in range(2)]))",
					resolve("../instant-finish-origin"),
					`${target.pathname}${target.search}`,
					String(Math.floor(Date.now() / 1000)),
				],
				{ encoding: "utf8" },
			),
		) as string[];
		const signs = tokens.map(
			(token) =>
				new Request(unsigned.url, {
					headers: { "x-cap-origin-service": token },
				}),
		);
		for (const signed of signs)
			expect((await GET(signed.clone())).status).toBe(200);
		for (const signed of signs)
			expect((await GET(signed.clone())).status).toBe(401);
		expect(state.storage).toBe(2);
	});
	it.each([
		{ ownerId: "anotherowner" },
		{ key: "private/source/original.mp4" },
		{ versionId: "null" },
		{ sha256: "invalid" },
		{ namespace: "invalid" },
	])(
		"never signals absence for malformed READY receipt %j",
		async (invalid) => {
			state.invalid = invalid;
			expect((await GET(request())).status).toBe(503);
			expect(state.storage).toBe(0);
		},
	);
	it.each([
		"&key=private/source/original.mp4",
		"&versionId=attacker",
		"&bucket=attacker",
	])("does not accept caller descriptors %s", async (extra) => {
		expect((await GET(request({ extra }))).status).toBe(400);
		expect(state.storage).toBe(0);
	});
	it("rejects superseded revision", async () => {
		expect((await GET(request({ revisionId: "oldrevision" }))).status).toBe(
			409,
		);
		expect(state.storage).toBe(0);
	});
	it("never serves partial receipts", async () => {
		state.partial = true;
		expect((await GET(request())).status).toBe(409);
		expect(state.storage).toBe(0);
	});
	it.each([
		{ captionsVtt: 123, chapters: [], thumbnailSha256: "" },
		{ captionsVtt: "", chapters: [{}], thumbnailSha256: "" },
		{ captionsVtt: "", chapters: [], thumbnailSha256: "not-a-hash" },
	])("validates untrusted HLS JSON structurally %j", async (badSnapshot) => {
		state.badSnapshot = badSnapshot;
		expect((await GET(request())).status).toBe(409);
		expect(state.storage).toBe(0);
	});
	it("rejects stale caption snapshot", async () => {
		state.snapshotChanged = true;
		expect((await GET(request({ name: "captions.vtt" }))).status).toBe(409);
		expect(state.storage).toBe(0);
	});
	it("keeps immutable media playable while side metadata is refreshed", async () => {
		state.snapshotChanged = true;
		expect((await GET(request())).status).toBe(200);
	});
	it("rejects checksum corruption without returning bytes or retrying", async () => {
		state.corrupt = true;
		const response = await GET(request());
		expect(response.status).toBe(503);
		expect(await response.text()).toBe("");
		expect(state.storage).toBe(1);
	});
	it("fences epoch changes after the storage await", async () => {
		state.race = true;
		const response = await GET(request());
		expect(response.status).toBe(410);
		expect(await response.text()).toBe("");
	});
	it("distinguishes absent receipts from corrupt or failed reads", async () => {
		state.missing = true;
		expect((await GET(request())).status).toBe(204);
		expect(state.storage).toBe(0);
	});
});

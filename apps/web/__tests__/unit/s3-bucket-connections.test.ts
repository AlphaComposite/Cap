import { createServer, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { S3Bucket, type Video } from "@cap/web-domain";
import * as HttpServerRequest from "@effect/platform/HttpServerRequest";
import { ConfigProvider, Effect, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getById: vi.fn() }));

vi.mock("@cap/database/crypto", () => ({
	decrypt: async (value: string) => value,
}));
vi.mock("@cap/web-backend/src/Database.ts", async () => {
	const { Effect } = await import("effect");
	class Database extends Effect.Service<Database>()("Database", {
		sync: () => ({}),
	}) {}
	return { Database };
});
vi.mock("@cap/web-backend/src/Aws.ts", async () => {
	const { Effect } = await import("effect");
	class AwsCredentials extends Effect.Service<AwsCredentials>()(
		"AwsCredentials",
		{
			sync: () => ({
				credentials: {
					accessKeyId: "default-key",
					secretAccessKey: "test-secret",
				},
			}),
		},
	) {}
	return { AwsCredentials };
});
vi.mock("@cap/web-backend/src/S3Buckets/S3BucketsRepo.ts", async () => {
	const { Effect } = await import("effect");
	class S3BucketsRepo extends Effect.Service<S3BucketsRepo>()("S3BucketsRepo", {
		sync: () => ({ getById: mocks.getById }),
	}) {}
	return { S3BucketsRepo };
});

import { S3Buckets } from "@cap/web-backend/src/S3Buckets";
import { s3ConnectionPool } from "@cap/web-backend/src/S3Buckets/S3ConnectionPool";
import { Storage } from "@cap/web-backend/src/Storage";
import { StorageRepo } from "@cap/web-backend/src/Storage/StorageRepo";

async function storageFixture() {
	let connections = 0;
	const sockets = new Set<Socket>();
	const authorizations: string[] = [];
	const server = createServer((request, response) => {
		authorizations.push(request.headers.authorization ?? "");
		response.writeHead(200, {
			"Content-Length": "1",
			ETag: '"source-identity"',
		});
		response.end();
	});
	server.on("connection", (socket) => {
		connections++;
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing port");
	const endpoint = `http://127.0.0.1:${address.port}`;
	const runtime = ManagedRuntime.make(
		S3Buckets.Default.pipe(
			Layer.provide(
				Layer.setConfigProvider(
					ConfigProvider.fromMap(
						new Map([
							["CAP_AWS_REGION", "us-east-1"],
							["CAP_AWS_BUCKET", "capso"],
							["S3_INTERNAL_ENDPOINT", endpoint],
							["S3_PUBLIC_ENDPOINT", endpoint],
						]),
					),
				),
			),
		),
	);
	const service = await runtime.runPromise(S3Buckets);
	return {
		endpoint,
		runtime,
		service,
		authorizations,
		connections: () => connections,
		async close() {
			await runtime.dispose();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

describe("S3 connection reuse", () => {
	it.each(["default", "custom"] as const)(
		"signs %s PUT and UploadPart without optional checksums and binds all metadata headers",
		async (bucketKind) => {
			const fixture = await storageFixture();
			try {
				mocks.getById.mockReturnValue(
					Effect.succeed(
						Option.some(
							S3Bucket.decodeSync({
								id: "custom-bucket",
								ownerId: "owner",
								region: "us-east-1",
								endpoint: fixture.endpoint,
								name: "custom-storage",
								accessKeyId: "custom-key",
								secretAccessKey: "custom-secret",
							}),
						),
					),
				);
				const [access] = await fixture.runtime.runPromise(
					fixture.service.getBucketAccess(
						bucketKind === "default"
							? Option.none()
							: Option.some(S3Bucket.S3BucketId.make("custom-bucket")),
					),
				);
				const metadata = {
					userid: "owner",
					duration: "0",
					resolution: "1920x1080",
					videocodec: "h264",
					audiocodec: "aac",
					source: "desktop",
					Custom: "extra",
				};
				const signing = {
					expiresIn: 123,
					signingDate: new Date("2026-01-01T00:00:00Z"),
				};
				const request = HttpServerRequest.fromWeb(
					new Request("http://10.0.0.42:3000/upload"),
				);
				for (const endpoint of ["public", "internal", "request"] as const) {
					const put = (values = metadata) => {
						const effect =
							endpoint === "internal"
								? access.getInternalPresignedPutUrl(
										"result.mp4",
										{ Metadata: values },
										signing,
									)
								: access.getPresignedPutUrl(
										"result.mp4",
										{ Metadata: values },
										signing,
									);
						return endpoint === "request"
							? effect.pipe(
									Effect.provideService(
										HttpServerRequest.HttpServerRequest,
										request,
									),
								)
							: effect;
					};
					const url = new URL(await fixture.runtime.runPromise(put()));
					expect(url.hostname).toBe(
						endpoint === "request" ? "10.0.0.42" : "127.0.0.1",
					);
					expect(url.searchParams.get("X-Amz-Expires")).toBe("123");
					expect(
						url.searchParams.get("X-Amz-SignedHeaders")?.split(";"),
					).toEqual(
						[
							"host",
							...Object.keys(metadata).map(
								(key) => `x-amz-meta-${key.toLowerCase()}`,
							),
						].sort(),
					);
					for (const key of Object.keys(metadata)) {
						expect(
							url.searchParams.has(`x-amz-meta-${key.toLowerCase()}`),
						).toBe(false);
					}
					const changed = new URL(
						await fixture.runtime.runPromise(
							put({ ...metadata, duration: "1" }),
						),
					);
					expect(changed.searchParams.get("X-Amz-Signature")).not.toBe(
						url.searchParams.get("X-Amz-Signature"),
					);
					const part = access.multipart.getPresignedUploadPartUrl(
						"result.mp4",
						"upload-id",
						1,
					);
					const partUrl = new URL(
						await fixture.runtime.runPromise(
							endpoint === "request"
								? part.pipe(
										Effect.provideService(
											HttpServerRequest.HttpServerRequest,
											request,
										),
									)
								: part,
						),
					);
					for (const signed of [url, partUrl]) {
						expect(signed.searchParams.has("x-amz-checksum-crc32")).toBe(false);
						expect(
							signed.searchParams.has("x-amz-sdk-checksum-algorithm"),
						).toBe(false);
					}
				}
				const fields = Object.fromEntries(
					Object.entries(metadata).map(([key, value]) => [
						`x-amz-meta-${key.toLowerCase()}`,
						value,
					]),
				);
				const target = await Effect.gen(function* () {
					const presign = vi.spyOn(access, "getPresignedPutUrl");
					const [storage] = yield* Storage.getAccessForVideo(
						{
							bucketId: Option.none(),
							storageIntegrationId: Option.none(),
						} as Video.Video,
						{ resolvePublishedOutput: false },
					);
					const target = yield* storage.createUploadTarget("result.mp4", {
						contentType: "video/mp4",
						fields,
					});
					expect(presign).toHaveBeenCalledWith(
						"result.mp4",
						{
							ContentType: "video/mp4",
							Metadata: Object.fromEntries(
								Object.entries(fields).map(([key, value]) => [
									key.slice("x-amz-meta-".length),
									value,
								]),
							),
						},
						{ expiresIn: 1800 },
					);
					return target;
				}).pipe(
					Effect.provide(
						Storage.DefaultWithoutDependencies.pipe(
							Layer.provide(
								Layer.mergeAll(
									Layer.succeed(StorageRepo, {} as StorageRepo),
									Layer.succeed(S3Buckets, {
										getBucketAccess: () =>
											Effect.succeed([access, Option.none()]),
									} as unknown as S3Buckets),
								),
							),
						),
					),
					Effect.runPromise,
				);
				expect(target.type).toBe("put");
				if (target.type !== "put") throw new Error("Expected PUT target");
				expect(target.headers).toEqual({
					"Content-Type": "video/mp4",
					...fields,
				});
				expect(
					new URL(target.url).searchParams
						.get("X-Amz-SignedHeaders")
						?.split(";"),
				).toEqual(
					[
						"host",
						...Object.keys(target.headers).map((key) => key.toLowerCase()),
					].sort(),
				);
				expect(fixture.authorizations).toEqual([]);
			} finally {
				await fixture.close();
			}
		},
	);

	it("bounds connections across simultaneous recording checkpoints", async () => {
		const fixture = await storageFixture();
		try {
			await Promise.all(
				Array.from({ length: 24 }, async (_, recording) => {
					const [access] = await fixture.runtime.runPromise(
						fixture.service.getBucketAccess(Option.none()),
					);
					await Promise.all(
						Array.from({ length: 8 }, (_, index) =>
							fixture.runtime.runPromise(
								access.headObject(`recording/${recording}/${index}`),
							),
						),
					);
				}),
			);
			expect(fixture.authorizations).toHaveLength(192);
			expect(fixture.connections()).toBeLessThanOrEqual(50);
		} finally {
			await fixture.close();
		}
	});

	it("expires idle connections, clears their timer on reuse, and closes on disposal", async () => {
		const fixture = await storageFixture();
		try {
			const socket = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const pool = yield* s3ConnectionPool;
						return yield* Effect.promise(async () => {
							const send = () =>
								new Promise<{ socket: Socket; timeout: number | undefined }>(
									(resolve, reject) => {
										let acquired: Socket | undefined;
										let timeout: number | undefined;
										const request = httpRequest(fixture.endpoint, {
											method: "HEAD",
											agent: pool.httpAgent,
										});
										request.on("socket", (socket) => {
											acquired = socket;
											timeout = socket.timeout;
										});
										request.on("response", (response) => {
											response.on("end", () => {
												if (acquired) resolve({ socket: acquired, timeout });
												else reject(new Error("Missing connection"));
											});
											response.resume();
										});
										request.on("error", reject);
										request.end();
									},
								);
							const first = await send();
							await new Promise<void>((resolve) => setImmediate(resolve));
							expect(first.socket.timeout).toBeGreaterThan(0);
							expect(first.socket.timeout).toBeLessThanOrEqual(30_000);
							const second = await send();
							expect(second.socket).toBe(first.socket);
							expect(second.timeout).toBe(0);
							return first.socket;
						});
					}),
				),
			);
			expect(socket.destroyed).toBe(true);
		} finally {
			await fixture.close();
		}
	});

	it("does not grow connections with every recording checkpoint", async () => {
		const fixture = await storageFixture();
		try {
			for (let checkpoint = 0; checkpoint < 40; checkpoint++) {
				const [access] = await fixture.runtime.runPromise(
					fixture.service.getBucketAccess(Option.none()),
				);
				await Promise.all(
					Array.from({ length: 8 }, (_, index) =>
						fixture.runtime.runPromise(
							access.headObject(`recording/${checkpoint}/${index}`),
						),
					),
				);
			}
			expect(fixture.authorizations).toHaveLength(320);
			expect(fixture.connections()).toBeLessThanOrEqual(16);
		} finally {
			await fixture.close();
		}
	});

	it("reuses custom bucket connections while using current credentials", async () => {
		const fixture = await storageFixture();
		try {
			for (let revision = 0; revision < 40; revision++) {
				mocks.getById.mockReturnValue(
					Effect.succeed(
						Option.some(
							S3Bucket.decodeSync({
								id: "custom-bucket",
								ownerId: "owner",
								region: "us-east-1",
								endpoint: fixture.endpoint,
								name: "custom-storage",
								accessKeyId: `rotated-key-${revision}`,
								secretAccessKey: "custom-secret",
							}),
						),
					),
				);
				const [access] = await fixture.runtime.runPromise(
					fixture.service.getBucketAccess(
						Option.some(S3Bucket.S3BucketId.make("custom-bucket")),
					),
				);
				await fixture.runtime.runPromise(access.headObject("fragment.m4s"));
				expect(fixture.authorizations.at(-1)).toContain(
					`Credential=rotated-key-${revision}/`,
				);
			}
			expect(fixture.connections()).toBeLessThanOrEqual(2);
		} finally {
			await fixture.close();
		}
	});
});

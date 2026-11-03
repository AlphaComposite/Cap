import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	type S3Client,
	UploadPartCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instant-finish-source-relocate", () => ({
	runtimeS3Client: () => {
		throw new Error("Unexpected runtime storage");
	},
}));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));

import {
	type DownloadReceipt,
	downloadRange,
	persistRevisionDownload,
	streamDurableDownload,
	verifiedDownloadReceipt,
} from "@/lib/revision-download-artifact";
import type { OriginClient } from "@/lib/revision-publication-origin";

const identity = {
	ownerId: "owner1234",
	videoId: "video1234",
	revisionId: "revision1234",
	generation: 7,
	sourceId: "source1234",
};
const namespace = Array(4).fill("a".repeat(64)).join("/");
const fixture = Buffer.from("final-edited-video-bytes");
const receipt: DownloadReceipt = {
	...identity,
	validation: "verified",
	namespace,
	bucket: "private",
	key: "owner1234/video1234/private/edited/revision1234/7/attempt.mp4",
	versionId: "version-1",
	size: fixture.length,
	sha256: createHash("sha256").update(fixture).digest("hex"),
};

function origin(
	bytes = fixture,
	advertisedSize = bytes.length,
	headerPatch: Record<string, string> = {},
	chunkBytes = 65536,
): OriginClient {
	return {
		prepareRevision: vi.fn(),
		selectFrames: vi.fn(),
		fetchArtifact: vi.fn(),
		streamDownload: async () => {
			let offset = 0;
			return {
				status: 200,
				headers: new Headers({
					"content-length": String(advertisedSize),
					"x-cap-video-id": identity.videoId,
					"x-cap-revision-id": identity.revisionId,
					"x-cap-source-id": identity.sourceId,
					"x-cap-generation": String(identity.generation),
					"x-cap-namespace": namespace,
					...headerPatch,
				}),
				body: new ReadableStream(
					{
						pull(stream) {
							if (offset >= bytes.length) {
								stream.close();
								return;
							}
							stream.enqueue(bytes.subarray(offset, offset + chunkBytes));
							offset += chunkBytes;
						},
					},
					{ highWaterMark: 0 },
				),
			};
		},
	};
}

function store(
	options: {
		corrupt?: boolean;
		truncate?: boolean;
		wrongVersion?: boolean;
		putFails?: boolean;
		fullRange?: boolean;
		bodyTruncate?: boolean;
	} = {},
) {
	const versions = new Map<string, Buffer>();
	const parts: Buffer[] = [];
	const commands: unknown[] = [];
	const send = vi.fn(async (command: unknown) => {
		commands.push(command);
		if (command instanceof CreateMultipartUploadCommand)
			return { UploadId: "upload-1" };
		if (command instanceof UploadPartCommand) {
			parts.push(Buffer.from(command.input.Body as Uint8Array));
			return { ETag: `part-${parts.length}` };
		}
		if (command instanceof AbortMultipartUploadCommand) return {};
		if (
			command instanceof PutObjectCommand ||
			command instanceof CompleteMultipartUploadCommand
		) {
			if (options.putFails) throw new Error("PUT failed");
			const uploaded: Buffer[] = [];
			if (command instanceof PutObjectCommand) {
				expect(command.input.Body).toBeInstanceOf(Readable);
				for await (const chunk of command.input.Body as Readable)
					uploaded.push(Buffer.from(chunk));
			}
			const bytes = Buffer.concat(
				command instanceof PutObjectCommand ? uploaded : parts,
			);
			versions.set(command.input.Key ?? "", bytes);
			return { VersionId: "version-1" };
		}
		if (command instanceof HeadObjectCommand)
			return {
				ContentLength: fixture.length,
				VersionId: options.wrongVersion ? "wrong" : "version-1",
			};
		if (command instanceof GetObjectCommand) {
			expect(command.input.VersionId).toBe("version-1");
			let bytes = versions.get(command.input.Key ?? "") ?? fixture;
			if (options.corrupt) bytes = Buffer.alloc(bytes.length, 0);
			const fullSize = bytes.length;
			const range =
				command.input.Range && !options.fullRange
					? downloadRange(command.input.Range, bytes.length)
					: null;
			if (range) bytes = bytes.subarray(range.start, range.end + 1);
			const contentLength = bytes.length;
			if (options.truncate || options.bodyTruncate)
				bytes = bytes.subarray(0, bytes.length - 1);
			const body = Readable.from([bytes]);
			return {
				VersionId: options.wrongVersion ? "wrong" : "version-1",
				ContentLength: contentLength,
				ContentRange: range
					? `bytes ${range.start}-${range.end}/${fullSize}`
					: undefined,
				$metadata: { httpStatusCode: range ? 206 : 200 },
				Body: Object.assign(body, {
					transformToWebStream: () => Readable.toWeb(body),
				}),
			};
		}
		throw new Error("Unexpected storage operation");
	});
	return {
		client: { send } as unknown as S3Client,
		versions,
		parts,
		commands,
		send,
	};
}

async function persist(backend = store(), source = origin()) {
	return persistRevisionDownload({
		identity,
		origin: source,
		signal: AbortSignal.timeout(5000),
		bucket: "private",
		client: backend.client,
	});
}

describe("immutable verified edited artifacts", () => {
	it("uploads bytes and independently hashes a full exact-version GET", async () => {
		const backend = store();
		const actual = await persist(backend);
		expect(actual.sha256).toBe(receipt.sha256);
		expect(actual.size).toBe(fixture.length);
		expect(verifiedDownloadReceipt(actual, identity)).toBe(true);
		expect(
			verifiedDownloadReceipt(actual, { ...identity, videoId: "another" }),
		).toBe(false);
		expect(
			backend.commands.map((command) => (command as object).constructor.name),
		).toEqual(["PutObjectCommand", "GetObjectCommand"]);
	});
	it.each([
		{ corrupt: true },
		{ truncate: true },
		{ wrongVersion: true },
		{ putFails: true },
	])(
		"rejects failed upload/readback %j without deleting any version",
		async (options) => {
			const backend = store(options);
			await expect(persist(backend)).rejects.toThrow();
			expect(
				backend.commands.some((command) =>
					/Delete/.test((command as object).constructor.name),
				),
			).toBe(false);
			if (!options.putFails) expect(backend.versions.size).toBe(1);
		},
	);
	it.each([8 * 1024 * 1024 + 123, 16 * 1024 * 1024, 16 * 1024 * 1024 + 123])(
		"uses bounded multipart buffers and verifies %i bytes across unaligned input chunks",
		async (size) => {
			const bytes = Buffer.alloc(size, 9);
			const backend = store();
			const result = await persist(backend, origin(bytes, size, {}, 65537));
			expect(
				backend.parts.every((part) => part.length <= 8 * 1024 * 1024),
			).toBe(true);
			expect(Buffer.concat(backend.parts).equals(bytes)).toBe(true);
			expect(result.sha256).toBe(
				createHash("sha256").update(bytes).digest("hex"),
			);
			expect(result.size).toBe(bytes.length);
		},
	);
	it("crash retry allocates a different immutable attempt key and preserves the first version", async () => {
		const backend = store();
		const first = await persist(backend);
		const second = await persist(backend);
		expect(first.key).not.toBe(second.key);
		expect(backend.versions.size).toBe(2);
	});
	it.each<Record<string, string>>([
		{ "x-cap-revision-id": "wrong-revision" },
		{ "x-cap-source-id": "wrong-source" },
		{ "x-cap-generation": "6" },
		{ "x-cap-namespace": "invalid" },
	])("rejects origin identity mismatch %j before upload", async (patch) => {
		const backend = store();
		await expect(
			persist(backend, origin(fixture, fixture.length, patch)),
		).rejects.toThrow("DownloadIdentityMismatch");
		expect(backend.commands).toHaveLength(0);
	});
	it("rejects truncated origin transport before completing a PUT", async () => {
		const backend = store();
		await expect(
			persist(backend, origin(fixture, fixture.length + 1)),
		).rejects.toThrow("DownloadLengthMismatch");
		expect(backend.versions.size).toBe(0);
	});
	it("honors cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			persistRevisionDownload({
				identity,
				origin: origin(),
				signal: controller.signal,
				bucket: "private",
				client: store().client,
			}),
		).rejects.toThrow();
	});
});

describe("version-pinned private byte delivery", () => {
	it("streams GET and sanitizes attachment name without exposing storage identifiers", async () => {
		const response = await streamDurableDownload({
			receipt,
			request: new Request("https://cap.test/edited"),
			filename: 'name"\r\nunsafe',
			client: store().client,
		});
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(fixture);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("content-disposition")).toBe(
			'attachment; filename="name___unsafe.mp4"',
		);
		expect([...response.headers.values()].join(" ")).not.toContain(receipt.key);
	});
	it("HEAD reads only the pinned version metadata", async () => {
		const backend = store();
		const response = await streamDurableDownload({
			receipt,
			request: new Request("https://cap.test/edited", { method: "HEAD" }),
			filename: "video",
			client: backend.client,
		});
		expect(response.status).toBe(200);
		expect(response.body).toBeNull();
		expect(backend.commands).toHaveLength(1);
		expect(backend.commands[0]).toBeInstanceOf(HeadObjectCommand);
	});
	it("preserves206 and exact bytes for bounded/open-ended ranges", async () => {
		for (const range of ["bytes=2-5", "bytes=2-"]) {
			const response = await streamDurableDownload({
				receipt,
				request: new Request("https://cap.test/edited", { headers: { range } }),
				filename: "video",
				client: store().client,
			});
			expect(response.status).toBe(206);
			const parsed = downloadRange(range, fixture.length);
			if (!parsed) throw new Error("Invalid test range");
			expect(Buffer.from(await response.arrayBuffer())).toEqual(
				fixture.subarray(parsed.start, parsed.end + 1),
			);
		}
	});
	it.each(["bytes=999-", "bytes=-4", "bytes=0-1,4-8", "bytes=4-2", "invalid"])(
		"returns416 for unsupported/out-of-bounds %s before contacting storage",
		async (range) => {
			const backend = store();
			const response = await streamDurableDownload({
				receipt,
				request: new Request("https://cap.test/edited", { headers: { range } }),
				filename: "video",
				client: backend.client,
			});
			expect(response.status).toBe(416);
			expect(response.headers.get("content-range")).toBe(
				`bytes */${fixture.length}`,
			);
			expect(backend.commands).toHaveLength(0);
		},
	);
	it("never mislabels an ignored range/full upstream response206", async () => {
		await expect(
			streamDurableDownload({
				receipt,
				request: new Request("https://cap.test/edited", {
					headers: { range: "bytes=2-5" },
				}),
				filename: "video",
				client: store({ fullRange: true }).client,
			}),
		).rejects.toThrow("DownloadResponseMismatch");
	});
	it("fails the body stream on truncation", async () => {
		const response = await streamDurableDownload({
			receipt,
			request: new Request("https://cap.test/edited"),
			filename: "video",
			client: store({ bodyTruncate: true }).client,
		});
		await expect(response.arrayBuffer()).rejects.toThrow(
			"DownloadResponseTruncated",
		);
	});
});

import {
	CreateMultipartUploadCommand,
	GetObjectCommand,
	HeadObjectCommand,
	type S3Client,
	UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { createS3Store } from "../../scripts/instant-finish-relocate";

const FIVE_GIB = 5 * 1024 * 1024 * 1024;

function streamBody() {
	return {
		transformToByteArray() {
			byteArrayCalls += 1;
			throw new Error("transformToByteArray");
		},
		async *[Symbol.asyncIterator]() {
			yield Buffer.from("abc");
			yield Buffer.from("def");
		},
	};
}

let byteArrayCalls = 0;
const sent: { name: string; input: Record<string, unknown> }[] = [];

function clientFor(size: number): S3Client {
	return {
		send: async (command: {
			constructor: { name: string };
			input: Record<string, unknown>;
		}) => {
			sent.push({ name: command.constructor.name, input: command.input });
			if (command instanceof HeadObjectCommand) {
				return { ContentLength: size };
			}
			if (command instanceof GetObjectCommand) {
				return { Body: streamBody() };
			}
			if (command instanceof CreateMultipartUploadCommand) {
				return { UploadId: "upload-1" };
			}
			if (command instanceof UploadPartCopyCommand) {
				return { CopyPartResult: { ETag: "etag-1" } };
			}
			return {};
		},
	} as unknown as S3Client;
}

describe("createS3Store bounded copy", () => {
	it("hashes and copies without transformToByteArray and uses multipart above 5 GiB", async () => {
		byteArrayCalls = 0;
		sent.length = 0;
		const small = createS3Store(clientFor(12), "bucket");
		await expect(small.sha256("old/key")).resolves.toBe(
			"bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
		);
		await small.copy("old/key name", "private/source/new");
		expect(byteArrayCalls).toBe(0);
		expect(sent.some((call) => call.name === "CopyObjectCommand")).toBe(true);
		expect(
			sent.find((call) => call.name === "CopyObjectCommand")?.input.CopySource,
		).toBe("bucket/old/key%20name");
		expect(sent.some((call) => call.name === "PutObjectCommand")).toBe(false);

		sent.length = 0;
		byteArrayCalls = 0;
		const large = createS3Store(clientFor(FIVE_GIB + 1), "bucket");
		await large.copy("big", "private/source/big");
		expect(byteArrayCalls).toBe(0);
		const names = sent.map((call) => call.name);
		expect(names[0]).toBe("HeadObjectCommand");
		expect(names).toContain("CreateMultipartUploadCommand");
		expect(
			names.filter((name) => name === "UploadPartCopyCommand"),
		).toHaveLength(1025);
		expect(names.at(-1)).toBe("CompleteMultipartUploadCommand");
		const ranges = sent
			.filter((call) => call.name === "UploadPartCopyCommand")
			.map((call) => call.input.CopySourceRange);
		expect(ranges[0]).toBe("bytes=0-5242879");
		expect(ranges.at(-1)).toBe(`bytes=${FIVE_GIB}-${FIVE_GIB}`);
		expect(names).not.toContain("CopyObjectCommand");
		expect(names).not.toContain("GetObjectCommand");
	});
});

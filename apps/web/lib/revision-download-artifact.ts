import { createHash, randomUUID } from "node:crypto";
import { addAbortSignal, Readable } from "node:stream";
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
import { serverEnv } from "@cap/env";
import { runtimeS3Client } from "@/lib/instant-finish-source-relocate";
import type { OriginClient } from "@/lib/revision-publication-origin";
import type { editRevision } from "../../../packages/database/schema";

export type DownloadReceipt = NonNullable<
	NonNullable<
		typeof editRevision.$inferSelect.metadataSnapshot
	>["downloadArtifact"]
>;
export type DownloadIdentity = Pick<
	DownloadReceipt,
	"ownerId" | "videoId" | "revisionId" | "generation" | "sourceId"
>;
export const DOWNLOAD_TRANSFER_MS = 10 * 60 * 1000;
const PART_BYTES = 8 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const NAMESPACE = /^[a-f0-9]{64}(\/[a-f0-9]{64}){3}$/;

export function verifiedDownloadReceipt(
	value: unknown,
	identity: DownloadIdentity,
): value is DownloadReceipt {
	if (!value || typeof value !== "object") return false;
	const receipt = value as DownloadReceipt;
	return (
		receipt.validation === "verified" &&
		receipt.ownerId === identity.ownerId &&
		receipt.videoId === identity.videoId &&
		receipt.revisionId === identity.revisionId &&
		receipt.sourceId === identity.sourceId &&
		receipt.generation === identity.generation &&
		[receipt.ownerId, receipt.videoId, receipt.revisionId].every(
			(id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id),
		) &&
		typeof receipt.sourceId === "string" &&
		receipt.sourceId.length > 0 &&
		Number.isSafeInteger(receipt.generation) &&
		receipt.generation >= 0 &&
		typeof receipt.namespace === "string" &&
		NAMESPACE.test(receipt.namespace) &&
		typeof receipt.key === "string" &&
		receipt.key.startsWith(
			`${identity.ownerId}/${identity.videoId}/private/edited/${identity.revisionId}/${identity.generation}/`,
		) &&
		typeof receipt.bucket === "string" &&
		receipt.bucket.length > 0 &&
		typeof receipt.versionId === "string" &&
		receipt.versionId.length > 0 &&
		receipt.versionId !== "null" &&
		SHA.test(receipt.sha256) &&
		Number.isSafeInteger(receipt.size) &&
		receipt.size > 0
	);
}

export async function persistRevisionDownload(input: {
	identity: DownloadIdentity;
	origin: OriginClient;
	signal: AbortSignal;
	client?: S3Client;
	bucket?: string;
}): Promise<DownloadReceipt> {
	input.signal.throwIfAborted();
	if (!input.origin.streamDownload)
		throw new Error("DownloadStreamUnavailable");
	const response = await input.origin.streamDownload({
		revisionId: input.identity.revisionId,
		signal: input.signal,
	});
	const body = response.body;
	try {
		const { headers } = response;
		const namespace = headers.get("x-cap-namespace") ?? "";
		const size = Number(headers.get("content-length"));
		if (
			response.status !== 200 ||
			!body ||
			headers.get("x-cap-video-id") !== input.identity.videoId ||
			headers.get("x-cap-revision-id") !== input.identity.revisionId ||
			headers.get("x-cap-source-id") !== input.identity.sourceId ||
			headers.get("x-cap-generation") !== String(input.identity.generation) ||
			!NAMESPACE.test(namespace) ||
			!Number.isSafeInteger(size) ||
			size <= 0 ||
			size > PART_BYTES * 10000
		) {
			throw new Error("DownloadIdentityMismatch");
		}
		const client = input.client ?? runtimeS3Client();
		const bucket = input.bucket ?? serverEnv().CAP_AWS_BUCKET;
		const key = `${input.identity.ownerId}/${input.identity.videoId}/private/edited/${input.identity.revisionId}/${input.identity.generation}/${randomUUID()}.mp4`;
		const reader = body.getReader();
		const cancelOrigin = () => {
			void reader.cancel(input.signal.reason).catch(() => {});
		};
		input.signal.addEventListener("abort", cancelOrigin, { once: true });
		const hash = createHash("sha256");
		let count = 0;
		let ended = false;
		const chunks = async function* () {
			for (;;) {
				input.signal.throwIfAborted();
				const { done, value } = await reader.read();
				input.signal.throwIfAborted();
				if (done) break;
				count += value.byteLength;
				if (count > size) throw new Error("DownloadLengthMismatch");
				hash.update(value);
				yield value;
			}
			if (count !== size) throw new Error("DownloadLengthMismatch");
			ended = true;
		};
		let uploadId: string | undefined;
		let uploadStream: Readable | undefined;
		let versionId: string | undefined;
		const parts: { ETag: string; PartNumber: number }[] = [];
		const options = { abortSignal: input.signal };
		try {
			if (size <= PART_BYTES) {
				uploadStream = addAbortSignal(
					input.signal,
					Readable.from(chunks(), { objectMode: false, highWaterMark: 65536 }),
				);
				const uploaded = await client.send(
					new PutObjectCommand({
						Bucket: bucket,
						Key: key,
						Body: uploadStream,
						ContentLength: size,
						ContentType: "video/mp4",
					}),
					options,
				);
				if (!ended) throw new Error("DownloadUploadIncomplete");
				versionId = uploaded.VersionId;
			} else {
				const created = await client.send(
					new CreateMultipartUploadCommand({
						Bucket: bucket,
						Key: key,
						ContentType: "video/mp4",
					}),
					options,
				);
				uploadId = created.UploadId;
				if (!uploadId) throw new Error("DownloadMultipartIdentityMissing");
				let part = Buffer.alloc(PART_BYTES);
				let used = 0;
				for await (const value of chunks()) {
					let offset = 0;
					while (offset < value.byteLength) {
						const copied = Math.min(
							part.length - used,
							value.byteLength - offset,
						);
						part.set(value.subarray(offset, offset + copied), used);
						used += copied;
						offset += copied;
						if (used === part.length && uploadId) {
							const PartNumber = parts.length + 1;
							const uploaded = await client.send(
								new UploadPartCommand({
									Bucket: bucket,
									Key: key,
									UploadId: uploadId,
									PartNumber,
									Body: part,
									ContentLength: used,
								}),
								options,
							);
							if (!uploaded.ETag) throw new Error("DownloadPartReceiptMissing");
							parts.push({ ETag: uploaded.ETag, PartNumber });
							used = 0;
							part = Buffer.alloc(
								Math.min(
									PART_BYTES,
									size - (count - value.byteLength + offset),
								),
							);
						}
					}
				}
				const completed = await client.send(
					new CompleteMultipartUploadCommand({
						Bucket: bucket,
						Key: key,
						UploadId: uploadId,
						MultipartUpload: { Parts: parts },
					}),
					options,
				);
				versionId = completed.VersionId;
				uploadId = undefined;
			}
		} finally {
			uploadStream?.destroy();
			input.signal.removeEventListener("abort", cancelOrigin);
			await reader.cancel().catch(() => {});
			reader.releaseLock();
			if (uploadId) {
				await client
					.send(
						new AbortMultipartUploadCommand({
							Bucket: bucket,
							Key: key,
							UploadId: uploadId,
						}),
						{ abortSignal: AbortSignal.timeout(10_000) },
					)
					.catch(() => {});
			}
		}
		if (!versionId || versionId === "null")
			throw new Error("DownloadVersionMissing");
		const sha256 = hash.digest("hex");
		const readback = await client.send(
			new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
			options,
		);
		try {
			if (
				readback.VersionId !== versionId ||
				readback.ContentLength !== size ||
				!readback.Body ||
				readback.$metadata.httpStatusCode !== 200 ||
				readback.ContentRange
			)
				throw new Error("DownloadReadbackIdentityMismatch");
			addAbortSignal(input.signal, readback.Body as Readable);
			const independent = createHash("sha256");
			let readBytes = 0;
			for await (const chunk of readback.Body as AsyncIterable<Uint8Array>) {
				input.signal.throwIfAborted();
				readBytes += chunk.byteLength;
				if (readBytes > size) throw new Error("DownloadReadbackLengthMismatch");
				independent.update(chunk);
			}
			if (readBytes !== size || independent.digest("hex") !== sha256)
				throw new Error("DownloadReadbackMismatch");
		} finally {
			(readback.Body as { destroy?: () => void } | undefined)?.destroy?.();
		}
		input.signal.throwIfAborted();
		return {
			...input.identity,
			namespace,
			bucket,
			key,
			versionId,
			sha256,
			size,
			validation: "verified",
		};
	} finally {
		if (body && !body.locked) await body.cancel().catch(() => {});
	}
}

export function downloadRange(
	header: string | null,
	size: number,
): { start: number; end: number } | null | false {
	if (!header) return null;
	const match = /^bytes=(\d+)-(\d*)$/.exec(header);
	if (!match) return false;
	const start = Number(match[1]);
	const end = match[2] ? Number(match[2]) : size - 1;
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start >= size ||
		end < start
	)
		return false;
	return { start, end: Math.min(end, size - 1) };
}

export async function streamDurableDownload(input: {
	receipt: DownloadReceipt;
	request: Request;
	filename: string;
	client?: S3Client;
}): Promise<Response> {
	const { receipt, request } = input;
	const headers = new Headers({
		"Cache-Control": "private, no-store",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"Accept-Ranges": "bytes",
		"Content-Type": "video/mp4",
		"Content-Disposition": `attachment; filename="${input.filename.replace(/[^A-Za-z0-9 ._-]/g, "_").slice(0, 160) || "video"}.mp4"`,
	});
	const range = downloadRange(request.headers.get("range"), receipt.size);
	if (range === false) {
		headers.set("Content-Range", `bytes */${receipt.size}`);
		return new Response(null, { status: 416, headers });
	}
	const controller = new AbortController();
	const signal = AbortSignal.any([
		request.signal,
		controller.signal,
		AbortSignal.timeout(DOWNLOAD_TRANSFER_MS),
	]);
	const client = input.client ?? runtimeS3Client();
	const base = {
		Bucket: receipt.bucket,
		Key: receipt.key,
		VersionId: receipt.versionId,
	};
	const expectedLength = range ? range.end - range.start + 1 : receipt.size;
	const expectedRange = range
		? `bytes ${range.start}-${range.end}/${receipt.size}`
		: undefined;
	headers.set("Content-Length", String(expectedLength));
	if (expectedRange) headers.set("Content-Range", expectedRange);
	if (request.method === "HEAD") {
		const head = await client.send(new HeadObjectCommand(base), {
			abortSignal: signal,
		});
		if (
			head.VersionId !== receipt.versionId ||
			head.ContentLength !== receipt.size
		)
			throw new Error("DownloadHeadMismatch");
		return new Response(null, { status: range ? 206 : 200, headers });
	}
	const result = await client.send(
		new GetObjectCommand({
			...base,
			...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
		}),
		{ abortSignal: signal },
	);
	if (
		!result.Body ||
		result.VersionId !== receipt.versionId ||
		result.ContentLength !== expectedLength ||
		result.$metadata.httpStatusCode !== (range ? 206 : 200) ||
		result.ContentRange !== expectedRange
	) {
		(result.Body as { destroy?: () => void } | undefined)?.destroy?.();
		throw new Error("DownloadResponseMismatch");
	}
	const reader = result.Body.transformToWebStream().getReader();
	const cancelUpstream = () => {
		void reader.cancel(signal.reason).catch(() => {});
	};
	signal.addEventListener("abort", cancelUpstream, { once: true });
	let sent = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			async pull(stream) {
				try {
					signal.throwIfAborted();
					const { done, value } = await reader.read();
					signal.throwIfAborted();
					if (done) {
						if (sent !== expectedLength)
							throw new Error("DownloadResponseTruncated");
						stream.close();
						signal.removeEventListener("abort", cancelUpstream);
						reader.releaseLock();
						return;
					}
					sent += value.byteLength;
					if (sent > expectedLength)
						throw new Error("DownloadResponseOverflow");
					stream.enqueue(value);
				} catch (error) {
					signal.removeEventListener("abort", cancelUpstream);
					controller.abort();
					await reader.cancel().catch(() => {});
					stream.error(error);
				}
			},
			async cancel() {
				signal.removeEventListener("abort", cancelUpstream);
				controller.abort();
				await reader.cancel().catch(() => {});
			},
		},
		{ highWaterMark: 0 },
	);
	return new Response(body, { status: range ? 206 : 200, headers });
}

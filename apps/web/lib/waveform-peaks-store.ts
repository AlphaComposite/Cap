import {
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { serverEnv } from "@cap/env";
import {
	PEAKS_CACHE_CONTROL,
	PEAKS_CONTENT_TYPE,
	PEAKS_MAX_OBJECT_BYTES,
	peaksObjectKey,
} from "@/lib/waveform-peaks";

function client() {
	const env = serverEnv();
	return {
		bucket: env.CAP_AWS_BUCKET,
		s3: new S3Client({
			region: env.CAP_AWS_REGION,
			endpoint: env.S3_INTERNAL_ENDPOINT,
			forcePathStyle: env.S3_PATH_STYLE,
			credentials: {
				accessKeyId: env.CAP_AWS_ACCESS_KEY ?? "",
				secretAccessKey: env.CAP_AWS_SECRET_KEY ?? "",
			},
		}),
	};
}

function admitted(key: string): boolean {
	const parts = key.split("/");
	if (parts.length !== 4 || parts[0] !== "private" || parts[1] !== "peaks") {
		return false;
	}
	return peaksObjectKey(parts[2] ?? "", parts[3] ?? "") === key;
}

export async function headPeaksObject(
	key: string,
): Promise<{ contentLength: number } | null> {
	if (!admitted(key)) return null;
	const { bucket, s3 } = client();
	try {
		const head = await s3.send(
			new HeadObjectCommand({ Bucket: bucket, Key: key }),
		);
		const contentLength = head.ContentLength ?? 0;
		if (contentLength <= 0 || contentLength > PEAKS_MAX_OBJECT_BYTES)
			return null;
		return { contentLength };
	} catch {
		return null;
	}
}

export async function readPeaksObject(key: string): Promise<Uint8Array | null> {
	if (!admitted(key)) return null;
	const { bucket, s3 } = client();
	try {
		const got = await s3.send(
			new GetObjectCommand({ Bucket: bucket, Key: key }),
		);
		if (
			got.ContentLength !== undefined &&
			got.ContentLength > PEAKS_MAX_OBJECT_BYTES
		) {
			return null;
		}
		const body = got.Body;
		if (!body || !("transformToByteArray" in body)) return null;
		const bytes = await body.transformToByteArray();
		if (bytes.byteLength > PEAKS_MAX_OBJECT_BYTES) return null;
		return bytes;
	} catch {
		return null;
	}
}

export async function putPeaksObject(
	videoId: string,
	sourceSha256: string,
	bytes: Uint8Array,
): Promise<void> {
	const key = peaksObjectKey(videoId, sourceSha256);
	if (!key || bytes.byteLength > PEAKS_MAX_OBJECT_BYTES) {
		throw new Error("peaks object refused");
	}
	const { bucket, s3 } = client();
	await s3.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: bytes,
			ContentType: PEAKS_CONTENT_TYPE,
			CacheControl: PEAKS_CACHE_CONTROL,
		}),
	);
}

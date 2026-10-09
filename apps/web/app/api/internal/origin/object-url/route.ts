import { db } from "@cap/database";
import { S3Buckets } from "@cap/web-backend";
import { Effect, Option } from "effect";
import { recordedOriginReadKeys } from "@/lib/instant-finish-source-relocate";
import {
	ORIGIN_SERVICE_HEADER,
	REVISION_MEDIA_GRANT_SKEW_SECONDS,
	verifyInternalServiceRequest,
} from "@/lib/revision-media-token";
import { runPromise } from "@/lib/server";

export const runtime = "nodejs";
const PATH = "/api/internal/origin/object-url";
const EXPIRES_IN = 300;
const headers = { "Cache-Control": "private, no-store" };

const MAX_BODY_BYTES = 4096;
// ponytail: single cap-web instance; use a shared atomic nonce store before scaling out.
const seenNonces = new Map<string, number>();

export async function POST(request: Request) {
	const tooLarge = () =>
		Response.json({ error: "Body too large" }, { status: 413, headers });
	if (Number(request.headers.get("Content-Length")) > MAX_BODY_BYTES) {
		void request.body?.cancel().catch(() => {});
		return tooLarge();
	}
	const reader = request.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		if (reader) {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_BODY_BYTES) {
					void reader.cancel().catch(() => {});
					return tooLarge();
				}
				chunks.push(value);
			}
		}
	} catch {
		return Response.json({ error: "Invalid body" }, { status: 400, headers });
	} finally {
		reader?.releaseLock();
	}
	const body = Buffer.concat(chunks, size);
	const token = request.headers.get(ORIGIN_SERVICE_HEADER) ?? "";
	if (
		!verifyInternalServiceRequest(token, {
			method: "POST",
			path: PATH,
			body,
			audience: "web-object-url",
		})
	) {
		return Response.json({ error: "Unauthorized" }, { status: 401, headers });
	}
	// Claims have already passed MAC/time validation; consume synchronously before any await.
	const { nonce, exp } = JSON.parse(
		Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
	);
	const now = Math.floor(Date.now() / 1000);
	for (const [used, expiry] of seenNonces) {
		if (expiry < now) seenNonces.delete(used);
	}
	if (typeof nonce !== "string" || !nonce || seenNonces.has(nonce)) {
		return Response.json({ error: "Unauthorized" }, { status: 401, headers });
	}
	seenNonces.set(nonce, exp + REVISION_MEDIA_GRANT_SKEW_SECONDS);
	let key: unknown;
	try {
		key = JSON.parse(body.toString("utf8"))?.key;
	} catch {
		return Response.json({ error: "Invalid body" }, { status: 400, headers });
	}
	try {
		if (
			typeof key !== "string" ||
			!(await recordedOriginReadKeys(db())).includes(key)
		) {
			const videoId = typeof key === "string" ? key.split("/")[2] : undefined;
			console.warn("origin object URL denied", {
				videoId:
					videoId && /^[A-Za-z0-9_-]{1,128}$/.test(videoId) ? videoId : null,
			});
			return Response.json({ error: "Forbidden" }, { status: 403, headers });
		}
		const objectKey = key;
		const urls = await Effect.gen(function* () {
			const [bucket] = yield* S3Buckets.getBucketAccess(Option.none());
			const getUrl = yield* bucket.getInternalSignedObjectUrl(objectKey, {
				expiresIn: EXPIRES_IN,
			});
			const headUrl = yield* bucket.getInternalSignedHeadUrl(objectKey, {
				expiresIn: EXPIRES_IN,
			});
			return { getUrl, headUrl, expiresIn: EXPIRES_IN };
		}).pipe(runPromise);
		return Response.json(urls, { headers });
	} catch {
		return Response.json(
			{ error: "Object URL unavailable" },
			{ status: 503, headers },
		);
	}
}

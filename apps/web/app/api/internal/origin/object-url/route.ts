import { db } from "@cap/database";
import { S3Buckets } from "@cap/web-backend";
import { Effect, Option } from "effect";
import { recordedOriginReadKeys } from "@/lib/instant-finish-source-relocate";
import {
	ORIGIN_SERVICE_HEADER,
	verifyInternalServiceRequest,
} from "@/lib/revision-media-token";
import { runPromise } from "@/lib/server";

export const runtime = "nodejs";
const PATH = "/api/internal/origin/object-url";
const EXPIRES_IN = 300;
const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
	const body = await request.text();
	if (
		!verifyInternalServiceRequest(
			request.headers.get(ORIGIN_SERVICE_HEADER) ?? "",
			{ method: "POST", path: PATH, body, audience: "web-object-url" },
		)
	) {
		return Response.json({ error: "Unauthorized" }, { status: 401, headers });
	}
	let key: unknown;
	try {
		key = JSON.parse(body)?.key;
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

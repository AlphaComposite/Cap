import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer } from "effect";
import {
	readDurableHlsArtifact,
	verifiedHlsReceipt,
} from "@/lib/revision-download-artifact";
import { readCurrentDownload } from "@/lib/revision-media-grant";
import {
	ORIGIN_SERVICE_HEADER,
	REVISION_MEDIA_GRANT_SKEW_SECONDS,
	verifyInternalServiceRequest,
} from "@/lib/revision-media-token";
import { apiToHandler } from "@/lib/server";

export const dynamic = "force-dynamic";
const PATH = "/api/internal/origin/revision-artifact";
// ponytail: single web instance, use shared atomic nonces before scaling out.
const seenNonces = new Map<string, number>();
const headers = {
	"Cache-Control": "private, no-store",
	"Referrer-Policy": "no-referrer",
};

function read(request: Request) {
	return Effect.gen(function* () {
		const url = new URL(request.url);
		const token = request.headers.get(ORIGIN_SERVICE_HEADER) ?? "";
		if (
			url.search.length > 2048 ||
			!verifyInternalServiceRequest(token, {
				method: "GET",
				path: `${PATH}${url.search}`,
				audience: "web-revision-artifact",
			})
		)
			return new Response(null, { status: 401, headers });
		const { nonce, exp } = JSON.parse(
			Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
		);
		const now = Math.floor(Date.now() / 1000);
		for (const [used, expiry] of seenNonces) {
			if (expiry < now) seenNonces.delete(used);
		}
		if (typeof nonce !== "string" || !nonce || seenNonces.has(nonce))
			return new Response(null, { status: 401, headers });
		seenNonces.set(nonce, exp + REVISION_MEDIA_GRANT_SKEW_SECONDS);
		const videoId = url.searchParams.get("videoId") ?? "";
		const revisionId = url.searchParams.get("revisionId") ?? "";
		const name = url.searchParams.get("name") ?? "";
		if (
			!/^[A-Za-z0-9_-]{8,64}$/.test(videoId) ||
			!/^[A-Za-z0-9_-]{8,128}$/.test(revisionId) ||
			!/^(playlist\.m3u8|init\.mp4|seg\/[0-9]+\.m4s|captions\.vtt|chapters\.json|thumbnail\.jpg)$/.test(
				name,
			) ||
			[...url.searchParams.keys()].some(
				(key) => !["videoId", "revisionId", "name"].includes(key),
			)
		)
			return new Response(null, { status: 400, headers });
		const current = yield* Effect.promise(() =>
			readCurrentDownload(videoId, undefined, { requireValidReceipt: true }),
		);
		if (!current) return new Response(null, { status: 204, headers });
		if (current.revisionId !== revisionId)
			return new Response(null, { status: 409, headers });
		if (current.receipt.hls === undefined)
			return new Response(null, { status: 204, headers });
		if (
			!verifiedHlsReceipt(
				current.receipt,
				current,
				current.receipt.hls.snapshot,
			)
		)
			return new Response(null, { status: 409, headers });
		const side = ["captions.vtt", "chapters.json", "thumbnail.jpg"].includes(
			name,
		);
		if (side && !verifiedHlsReceipt(current.receipt, current, current.snapshot))
			return new Response(null, { status: 409, headers });
		const artifacts = current.receipt.hls.artifacts;
		const artifact = Object.hasOwn(artifacts, name)
			? artifacts[name]
			: undefined;
		if (!artifact) return new Response(null, { status: 404, headers });
		const signal = AbortSignal.any([
			request.signal,
			AbortSignal.timeout(30_000),
		]);
		const bytes = yield* Effect.promise(() =>
			readDurableHlsArtifact(artifact, signal),
		);
		const again = yield* Effect.promise(() =>
			readCurrentDownload(videoId, undefined, { requireValidReceipt: true }),
		);
		if (
			!again ||
			again.revisionId !== revisionId ||
			again.publicationEpoch !== current.publicationEpoch ||
			again.policyEpoch !== current.policyEpoch ||
			JSON.stringify(again.receipt) !== JSON.stringify(current.receipt) ||
			!verifiedHlsReceipt(
				again.receipt,
				again,
				side ? again.snapshot : current.receipt.hls.snapshot,
			)
		)
			return new Response(null, { status: 410, headers });
		return new Response(new Uint8Array(bytes), {
			headers: {
				...headers,
				"Content-Type": "application/octet-stream",
				"Content-Length": String(bytes.length),
				"X-Cap-Sha256": artifact.sha256,
				"X-Cap-Namespace": artifact.namespace,
				"X-Cap-Video-Id": current.videoId,
				"X-Cap-Revision-Id": current.revisionId,
				"X-Cap-Source-Id": current.sourceId,
				"X-Cap-Generation": String(current.generation),
				"X-Cap-Publication-Epoch": String(current.publicationEpoch),
				"X-Cap-Policy-Epoch": String(current.policyEpoch),
			},
		});
	}).pipe(
		Effect.catchAllCause(() =>
			Effect.succeed(new Response(null, { status: 503, headers })),
		),
	);
}

class Api extends HttpApi.make("OriginRevisionArtifact").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("get")`/api/internal/origin/revision-artifact`,
	),
) {}
const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handleRaw("get", ({ request }) => {
				if (!(request.source instanceof Request))
					return Effect.succeed(HttpServerResponse.empty({ status: 400 }));
				return read(request.source).pipe(
					Effect.map((response) =>
						HttpServerResponse.raw(response.body, {
							status: response.status,
							headers: response.headers,
						}),
					),
				);
			}),
		),
	),
);
export const GET = apiToHandler(ApiLive);

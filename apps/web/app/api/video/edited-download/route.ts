import { getCurrentUser } from "@cap/database/auth/session";
import { provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import { User, Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Option } from "effect";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import { streamDurableDownload } from "@/lib/revision-download-artifact";
import { readCurrentDownload } from "@/lib/revision-media-grant";
import { verifyRevisionMediaGrant } from "@/lib/revision-media-token";
import { apiToHandler } from "@/lib/server";
import { canUserDownloadVideo } from "@/lib/video-download-permissions";

export const dynamic = "force-dynamic";

function denied(status: number) {
	return new Response(null, {
		status,
		headers: {
			"Cache-Control": "private, no-store",
			"Referrer-Policy": "no-referrer",
		},
	});
}

function editedDownload(request: Request) {
	return Effect.gen(function* () {
		const url = new URL(request.url);
		const videoId = url.searchParams.get("videoId") ?? "";
		if (!/^[A-Za-z0-9_-]{8,64}$/.test(videoId)) return denied(400);
		const grant = verifyRevisionMediaGrant(url.searchParams.get("t") ?? "");
		if (!grant.ok) return denied(401);
		if (
			grant.payload.artifact !== "download" ||
			grant.payload.videoId !== videoId
		)
			return denied(403);
		const policy = yield* VideosPolicy;
		const user = yield* Effect.promise(getCurrentUser);
		if (!user) return denied(401);
		const authorize = Effect.gen(function* () {
			const current = yield* Effect.promise(() => readCurrentDownload(videoId));
			if (
				!current ||
				!isInstantFinishEnabledForOwner(current.ownerId) ||
				current.revisionId !== grant.payload.revisionId ||
				current.publicationEpoch !== grant.payload.publicationEpoch ||
				current.policyEpoch !== grant.payload.policyEpoch
			)
				return null;
			const viewable = yield* policy
				.getViewableById(Video.VideoId.make(videoId))
				.pipe(
					Effect.map(Option.isSome),
					Effect.catchAll(() => Effect.succeed(false)),
				);
			if (!viewable) return null;
			const allowed = yield* Effect.promise(() =>
				canUserDownloadVideo({
					userId: user.id,
					ownerId: User.UserId.make(current.ownerId),
					videoId: Video.VideoId.make(videoId),
				}),
			);
			return allowed ? current : null;
		});
		const current = yield* authorize;
		if (!current) return denied(403);
		const response = yield* Effect.tryPromise({
			try: () =>
				streamDurableDownload({
					receipt: current.receipt,
					request,
					filename: current.name,
				}),
			catch: () => "unavailable" as const,
		}).pipe(Effect.catchAll(() => Effect.succeed(denied(502))));
		const again = yield* authorize.pipe(
			Effect.catchAllCause(() => Effect.succeed(null)),
		);
		if (
			!again ||
			again.receipt.key !== current.receipt.key ||
			again.receipt.versionId !== current.receipt.versionId
		) {
			yield* Effect.promise(async () => {
				await response.body?.cancel().catch(() => {});
			});
			return denied(410);
		}
		return response;
	}).pipe(
		provideOptionalAuth,
		Effect.catchAllCause(() => Effect.succeed(denied(502))),
	);
}

class Api extends HttpApi.make("EditedDownload").add(
	HttpApiGroup.make("root")
		.add(HttpApiEndpoint.get("get")`/api/video/edited-download`)
		.add(HttpApiEndpoint.head("head")`/api/video/edited-download`),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) => {
			const read = ({ request }: { request: { source: unknown } }) => {
				if (!(request.source instanceof Request))
					return Effect.succeed(
						HttpServerResponse.empty({
							status: 400,
							headers: { "Cache-Control": "private, no-store" },
						}),
					);
				return editedDownload(request.source).pipe(
					Effect.map((response) =>
						HttpServerResponse.raw(response.body, {
							status: response.status,
							headers: response.headers,
						}),
					),
				);
			};
			return handlers.handleRaw("get", read).handleRaw("head", read);
		}),
	),
);

const handler = apiToHandler(ApiLive);
export const GET = handler;
export const HEAD = handler;

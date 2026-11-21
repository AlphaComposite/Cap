import type { Video } from "@cap/web-domain";
import { dataLoader } from "@effect/experimental/RequestResolver";
import { Effect, Request, RequestResolver } from "effect";
import type { NonEmptyArray } from "effect/Array";
import { Rpc } from "@/lib/Rpcs";

export namespace ThumbnailRequest {
	export const queryKey = (videoId: string) => ["thumbnail", videoId] as const;

	export class ThumbnailRequest extends Request.Class<
		string,
		unknown,
		{ videoId: Video.VideoId }
	> {}

	export class DataLoaderResolver extends Effect.Service<DataLoaderResolver>()(
		"ThumbnailRequest/DataLoaderResolver",
		{
			scoped: Effect.gen(function* () {
				const rpc = yield* Rpc;

				const requestResolver = RequestResolver.makeBatched(
					(requests: NonEmptyArray<ThumbnailRequest>) =>
						rpc.VideosGetThumbnails(requests.map((r) => r.videoId)).pipe(
							Effect.flatMap((results) =>
								Effect.forEach(requests, (request, index) => {
									const result = results[index];
									return result
										? Effect.matchEffect(Effect.flatten(result), {
												onSuccess: (v) => Request.succeed(request, v),
												onFailure: (e) => Request.fail(request, e),
											})
										: Request.fail(
												request,
												new Error("Missing thumbnail response"),
											);
								}),
							),
							Effect.catchAll((error) =>
								Effect.forEach(
									requests,
									(request) => Request.fail(request, error),
									{
										discard: true,
									},
								),
							),
						),
				);

				return yield* dataLoader(requestResolver, {
					window: "10 millis",
				});
			}),
			dependencies: [Rpc.Default],
		},
	) {}
}

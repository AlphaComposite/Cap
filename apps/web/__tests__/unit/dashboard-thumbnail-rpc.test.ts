import { readFileSync } from "node:fs";
import { Database } from "@cap/web-backend/src/Database";
import { OrganisationsRepo } from "@cap/web-backend/src/Organisations/OrganisationsRepo";
import { SpacesRepo } from "@cap/web-backend/src/Spaces/SpacesRepo";
import { Storage } from "@cap/web-backend/src/Storage";
import { Tinybird } from "@cap/web-backend/src/Tinybird";
import { Videos } from "@cap/web-backend/src/Videos";
import { VideosPolicy } from "@cap/web-backend/src/Videos/VideosPolicy";
import { VideosRepo } from "@cap/web-backend/src/Videos/VideosRepo";
import { VideosRpcsLive } from "@cap/web-backend/src/Videos/VideosRpcs";
import { Organisation, User, Video } from "@cap/web-domain";
import { Headers } from "@effect/platform";
import { Cause, Effect, Exit, Layer, Logger, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	flagged: vi.fn(() => true),
	eligible: vi.fn(async () => false),
	artifact: vi.fn(async () => null as string | null),
	access: vi.fn(),
	list: vi.fn(),
	sign: vi.fn(),
}));
vi.mock("@cap/web-backend/src/Videos/instantFinishFlag.ts", () => ({
	isInstantFinishEnabledForOwner: mocks.flagged,
}));
vi.mock("@cap/web-backend/src/flagged-unedited.ts", async (original) => ({
	...(await original<typeof import("@cap/web-backend/src/flagged-unedited")>()),
	loadEligibleLegacy: mocks.eligible,
}));
vi.mock("@/lib/revision-media-grant", () => ({
	revisionArtifactUrl: mocks.artifact,
}));
vi.mock(
	"@cap/web-backend",
	async () =>
		import("../../../../packages/web-backend/src/Videos/editedThumbnail"),
);
vi.mock("@cap/web-backend/src/Auth.ts", () => ({
	provideOptionalAuth: <A>(effect: A) => effect,
}));

import { ThumbnailRequest } from "@/lib/Requests/ThumbnailRequest";
import { Rpc } from "@/lib/Rpcs";
import { ensureEditedThumbnailLookup } from "@/lib/register-edited-thumbnail";

const videoId = Video.VideoId.make("video");
const ownerId = User.UserId.make("owner");
const readyUrl = "/media/video/r/current/thumbnail.jpg?t=test-grant";
const legacyKey = "owner/video/screenshot/screen-capture.jpg";
let video: Video.Video | null;
let password: Option.Option<string>;

function dependencies() {
	const repos = Layer.mergeAll(
		Layer.mock(Database, { _tag: "Database" }),
		Layer.mock(VideosRepo, {
			_tag: "VideosRepo",
			getById: () =>
				Effect.succeed(
					video ? Option.some([video, password] as const) : Option.none(),
				),
		}),
		Layer.mock(OrganisationsRepo, {
			_tag: "OrganisationsRepo",
			allowedEmailDomain: () => Effect.succeed(Option.none()),
		}),
		Layer.mock(SpacesRepo, {
			_tag: "SpacesRepo",
			passwordsForVideo: () => Effect.succeed([]),
		}),
		Layer.mock(Storage, { _tag: "Storage", getAccessForVideo: mocks.access }),
		Layer.mock(Tinybird, { _tag: "Tinybird", enabled: false }),
	);
	return Layer.merge(
		repos,
		VideosPolicy.DefaultWithoutDependencies.pipe(Layer.provide(repos)),
	);
}

function runThumbnail() {
	return Effect.runPromiseExit(
		Effect.flatMap(Videos, (videos) => videos.getThumbnailURL(videoId)).pipe(
			Effect.provide(Videos.DefaultWithoutDependencies),
			Effect.provide(dependencies()),
			Effect.provide(Logger.remove(Logger.defaultLogger)),
		),
	);
}

beforeEach(() => {
	mocks.flagged.mockReturnValue(true);
	mocks.eligible.mockResolvedValue(false);
	mocks.artifact.mockResolvedValue(readyUrl);
	mocks.list.mockReturnValue(
		Effect.succeed({ Contents: [{ Key: legacyKey }] }),
	);
	mocks.sign.mockImplementation((key: string) =>
		Effect.succeed(`https://storage.test/${key}`),
	);
	mocks.access.mockReturnValue(
		Effect.succeed([
			{ listObjects: mocks.list, getSignedObjectUrl: mocks.sign },
			Option.none(),
		]),
	);
	password = Option.none();
	video = Video.Video.make({
		id: videoId,
		ownerId,
		orgId: Organisation.OrganisationId.make("org"),
		name: "Edited clip",
		public: true,
		source: { type: "webMP4" },
		metadata: Option.none(),
		bucketId: Option.none(),
		storageIntegrationId: Option.none(),
		folderId: Option.none(),
		transcriptionStatus: Option.none(),
		width: Option.none(),
		height: Option.none(),
		duration: Option.none(),
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	ensureEditedThumbnailLookup();
});

describe("dashboard thumbnail RPC", () => {
	it("returns the current revision thumbnail instead of None or an old screenshot", async () => {
		expect(await runThumbnail()).toEqual(Exit.succeed(Option.some(readyUrl)));
		expect(mocks.artifact).toHaveBeenCalledExactlyOnceWith({
			videoId,
			ownerId,
			artifact: "thumbnail",
			child: "thumbnail.jpg",
		});
		expect(mocks.access).not.toHaveBeenCalled();
	});

	it("returns None when the current artifact is unavailable, without legacy fallback", async () => {
		mocks.artifact.mockResolvedValue(null);
		expect(await runThumbnail()).toEqual(Exit.succeed(Option.none()));
		expect(mocks.artifact).toHaveBeenCalledOnce();
		expect(mocks.access).not.toHaveBeenCalled();
	});

	it.each(["unflagged", "eligible"])(
		"keeps %s videos on the legacy path",
		async (kind) => {
			mocks.flagged.mockReturnValue(kind !== "unflagged");
			mocks.eligible.mockResolvedValue(kind === "eligible");
			expect(await runThumbnail()).toEqual(
				Exit.succeed(Option.some(`https://storage.test/${legacyKey}`)),
			);
			expect(mocks.artifact).not.toHaveBeenCalled();
			expect(mocks.list).toHaveBeenCalledExactlyOnceWith({
				prefix: "owner/video/",
			});
		},
	);

	it.each(["private", "password", "missing"])(
		"checks %s viewing policy before revision lookup or storage access",
		async (kind) => {
			if (!video) throw new Error("Missing video fixture");
			if (kind === "missing") video = null;
			else if (kind === "private")
				video = Video.Video.make({ ...video, public: false });
			else password = Option.some("password-hash");
			const result = await runThumbnail();
			if (kind === "missing")
				expect(result).toEqual(Exit.succeed(Option.none()));
			else {
				expect(Exit.isFailure(result)).toBe(true);
				if (Exit.isFailure(result))
					expect(
						Option.getOrThrow(Cause.failureOption(result.cause))._tag,
					).toBe(
						kind === "private" ? "PolicyDenied" : "VerifyVideoPasswordError",
					);
			}
			expect(mocks.eligible).not.toHaveBeenCalled();
			expect(mocks.artifact).not.toHaveBeenCalled();
			expect(mocks.access).not.toHaveBeenCalled();
		},
	);

	it("passes the revision URL through the real RPC handler and dashboard request resolver", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const handle = yield* Video.VideoRpcs.accessHandler(
					"VideosGetThumbnails",
				);
				return yield* Effect.gen(function* () {
					const resolver = yield* ThumbnailRequest.DataLoaderResolver;
					return yield* Effect.request(
						new ThumbnailRequest.ThumbnailRequest({ videoId }),
						resolver,
					);
				}).pipe(
					Effect.provide(
						ThumbnailRequest.DataLoaderResolver.DefaultWithoutDependencies,
					),
					Effect.provide(
						Layer.mock(Rpc, {
							_tag: "Rpc",
							VideosGetThumbnails: vi
								.fn()
								.mockImplementation((ids) => handle(ids, Headers.empty)),
						}),
					),
				);
			}).pipe(
				Effect.provide(VideosRpcsLive),
				Effect.provide(Videos.DefaultWithoutDependencies),
				Effect.provide(dependencies()),
				Effect.provide(Logger.remove(Logger.defaultLogger)),
				Effect.scoped,
			),
		);
		expect(result).toBe(readyUrl);
		expect(mocks.access).not.toHaveBeenCalled();
	});

	it("registers the lookup in the eRPC entrypoint before building the handler", () => {
		const source = readFileSync(
			new URL("../../app/api/erpc/route.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain(
			'import { ensureEditedThumbnailLookup } from "@/lib/register-edited-thumbnail"',
		);
		const registeredAt = source.indexOf("ensureEditedThumbnailLookup();");
		expect(registeredAt).toBeGreaterThan(-1);
		expect(registeredAt).toBeLessThan(source.indexOf("RpcServer.toWebHandler"));
		const exports = readFileSync(
			new URL("../../../../packages/web-backend/src/index.ts", import.meta.url),
			"utf8",
		);
		expect(exports).toContain(
			'export { registerEditedThumbnailUrlLookup } from "./Videos/editedThumbnail.ts"',
		);
	});
});

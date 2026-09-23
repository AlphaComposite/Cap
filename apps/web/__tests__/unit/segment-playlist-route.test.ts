import type { HttpApi } from "@effect/platform";
import type { Context, Layer as EffectLayer } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	manifest: {} as Record<string, unknown>,
	audioInitExists: false,
	storageUnavailable: false,
	denied: false,
	sourceType: "desktopSegments" as "desktopSegments" | "webMP4",
	metadata: null as Record<string, unknown> | null,
	videoEditExists: false,
	rawFileKey: null as string | null,
	rawObjectExists: false,
	getAccess: vi.fn(),
	sign: vi.fn(),
	head: vi.fn(),
	read: vi.fn(),
	dispose: async () => {},
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	NODE_ENV: "test",
}));

vi.mock("@cap/web-backend", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/web-backend")>();
	const { Context, Effect, Option } = await import("effect");
	const { Policy, Storage: StorageDomain } = await import("@cap/web-domain");
	const schema = await import("@cap/database/schema");
	const bucket = {
		getObject: () =>
			Effect.sync(() => {
				mocks.read();
				return Option.some(JSON.stringify(mocks.manifest));
			}),
		getSignedObjectUrl: (key: string) =>
			Effect.sync(() => {
				mocks.sign(key);
				return `https://media.example.com/${key}`;
			}),
		headObject: (key: string) => {
			mocks.head(key);
			return mocks.rawObjectExists
				? Effect.succeed({ ContentLength: 764 })
				: Effect.fail(new Error("Not found"));
		},
		listObjects: ({ prefix }: { prefix: string }) =>
			mocks.storageUnavailable
				? Effect.fail(
						new StorageDomain.StorageError({ cause: "storage unavailable" }),
					)
				: Effect.succeed({
						Contents: mocks.audioInitExists ? [{ Key: prefix, Size: 764 }] : [],
					}),
	};
	const fakeDb = {
		select: () => ({
			from: (table: unknown) => ({
				where: () =>
					Promise.resolve(
						table === schema.videoEdits && mocks.videoEditExists
							? [{ videoId: "recording" }]
							: table === schema.videoUploads && mocks.rawFileKey
								? [{ rawFileKey: mocks.rawFileKey }]
								: [],
					),
			}),
		}),
	};
	return {
		...actual,
		Database: Object.assign(Context.GenericTag("PlaylistTestDatabase"), {
			testService: {
				use: <T>(callback: (db: typeof fakeDb) => Promise<T>) =>
					Effect.tryPromise(() => callback(fakeDb)),
			},
		}),
		provideOptionalAuth: <A, E, R>(
			effect: import("effect").Effect.Effect<A, E, R>,
		) => effect,
		Storage: Object.assign(Context.GenericTag("PlaylistTestStorage"), {
			getAccessForVideo: () => {
				mocks.getAccess();
				return Effect.succeed([bucket, false] as const);
			},
		}),
		Videos: Object.assign(Context.GenericTag("PlaylistTestVideos"), {
			testService: {
				getByIdForViewing: () =>
					mocks.denied
						? Effect.fail(new Policy.PolicyDeniedError())
						: Effect.succeed(
								Option.some([
									{
										id: "recording",
										ownerId: "owner",
										source: { type: mocks.sourceType },
										metadata: Option.fromNullable(mocks.metadata),
									},
								]),
							),
			},
		}),
	};
});

vi.mock("@/lib/server", async () => {
	const { Database, Storage, Videos } = await import("@cap/web-backend");
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Layer } = await import("effect");
	return {
		apiToHandler: (
			api: EffectLayer.Layer<
				HttpApi.Api,
				never,
				| Context.Tag.Identifier<typeof Storage>
				| Context.Tag.Identifier<typeof Videos>
			>,
		) => {
			const videos = Videos as unknown as {
				testService: Context.Tag.Service<typeof Videos>;
			};
			const database = Database as unknown as {
				testService: Context.Tag.Service<typeof Database>;
			};
			const handler = api.pipe(
				Layer.provideMerge(
					Layer.succeed(Storage, {} as Context.Tag.Service<typeof Storage>),
				),
				Layer.provideMerge(Layer.succeed(Videos, videos.testService)),
				Layer.provideMerge(Layer.succeed(Database, database.testService)),
				Layer.merge(HttpServer.layerContext),
				HttpApiBuilder.toWebHandler,
			);
			mocks.dispose = handler.dispose;
			return handler.handler;
		},
	};
});

import { GET } from "@/app/api/playlist/route";

const request = (type = "segments-status", suffix = "&requireComplete=1") =>
	GET(
		new Request(
			`https://cap.so/api/playlist?videoId=recording&videoType=${type}${suffix}`,
		),
	);

const rawPreviewRequest = () => request("raw-preview", "");

describe("Instant playlist readiness API", () => {
	beforeEach(() => {
		mocks.manifest = {
			version: 2,
			video_init_uploaded: true,
			audio_init_uploaded: true,
			video_segments: [1, 2],
			audio_segments: [1, 2],
			is_complete: true,
		};
		mocks.audioInitExists = false;
		mocks.storageUnavailable = false;
		mocks.denied = false;
		mocks.sourceType = "desktopSegments";
		mocks.metadata = null;
		mocks.videoEditExists = false;
		mocks.rawFileKey = null;
		mocks.rawObjectExists = false;
		mocks.getAccess.mockClear();
		mocks.sign.mockClear();
		mocks.head.mockClear();
		mocks.read.mockClear();
	});
	afterAll(() => mocks.dispose());

	it("checks readiness without signing every segment URL", async () => {
		expect((await request()).status).toBe(204);
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it.each([
		"segments-status",
		"segments-master",
		"segments-video",
		"segments-audio",
	])("rejects missing audio on %s", async (type) => {
		mocks.manifest.audio_init_uploaded = false;
		expect((await request(type)).status).toBe(409);
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it.each([
		{ type: "segments-master", editState: "saved" },
		{ type: "segments-video", editState: "saved" },
		{ type: "segments-audio", editState: "saved" },
		{ type: "segments-status", editState: "saved" },
		{ type: "segments-master", editState: "pending" },
		{ type: "segments-video", editState: "pending" },
		{ type: "segments-audio", editState: "pending" },
		{ type: "segments-status", editState: "pending" },
	] as const)(
		"rejects $type for an edited video ($editState edit)",
		async ({ type, editState }) => {
			if (editState === "saved") mocks.videoEditExists = true;
			else mocks.metadata = { editProcessing: { dispatch: "pending" } };

			const response = await request(type);

			expect(response.status).toBe(404);
			expect(mocks.getAccess).not.toHaveBeenCalled();
			expect(mocks.read).not.toHaveBeenCalled();
			expect(mocks.sign).not.toHaveBeenCalled();
		},
	);

	it("keeps unedited segment playlists available", async () => {
		const response = await request("segments-video", "");

		expect(response.status).toBe(200);
		expect(await response.text()).toContain("https://media.example.com/");
		expect(mocks.sign).toHaveBeenCalled();
	});

	it("keeps the rendered MP4 available for an edited webMP4 video", async () => {
		mocks.sourceType = "webMP4";
		mocks.videoEditExists = true;

		const response = await request("mp4", "");

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			"https://media.example.com/owner/recording/result.mp4",
		);
		expect(mocks.sign).toHaveBeenCalledWith("owner/recording/result.mp4");
	});

	it("does not expose a partial video as ready while its last segments upload", async () => {
		mocks.manifest.is_complete = false;
		expect((await request()).status).toBe(202);
		expect((await request("segments-master")).status).toBe(404);
		expect((await request("segments-master", "")).status).toBe(200);
	});

	it("preserves legacy audio only when the missing init flag is contradicted by stored bytes", async () => {
		mocks.manifest.version = 1;
		mocks.manifest.audio_init_uploaded = false;
		expect((await request()).status).toBe(409);
		mocks.audioInitExists = true;
		expect((await request()).status).toBe(204);
		expect(await (await request("segments-master")).text()).toContain(
			"#EXT-X-MEDIA:TYPE=AUDIO",
		);
	});

	it("does not misreport a storage outage as missing audio", async () => {
		mocks.manifest.version = 1;
		mocks.manifest.audio_init_uploaded = false;
		mocks.storageUnavailable = true;
		expect((await request()).status).toBe(500);
	});

	it("retains viewing authorization before probing private media", async () => {
		mocks.denied = true;
		expect((await request()).status).toBe(401);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("rejects raw previews for videos with a saved edit before using rawFileKey", async () => {
		mocks.sourceType = "webMP4";
		mocks.videoEditExists = true;
		mocks.rawFileKey = "owner/recording/raw-upload.mp4";

		const response = await rawPreviewRequest();

		expect(response.status).toBe(404);
		expect(mocks.sign).not.toHaveBeenCalled();
		expect(mocks.head).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain(mocks.rawFileKey);
	});

	it("rejects raw previews during a pending edit before probing fallback keys", async () => {
		mocks.sourceType = "webMP4";
		mocks.metadata = { editProcessing: { dispatch: "pending" } };
		mocks.rawObjectExists = true;

		const response = await rawPreviewRequest();

		expect(response.status).toBe(404);
		expect(mocks.sign).not.toHaveBeenCalled();
		expect(mocks.head).not.toHaveBeenCalled();
		expect(await response.text()).not.toContain("raw-upload");
	});

	it("keeps raw preview access for an unedited webMP4 video", async () => {
		mocks.sourceType = "webMP4";
		mocks.rawFileKey = "owner/recording/raw-upload.mp4";

		const response = await rawPreviewRequest();

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			"https://media.example.com/owner/recording/raw-upload.mp4",
		);
		expect(mocks.sign).toHaveBeenCalledWith(mocks.rawFileKey);
	});
});

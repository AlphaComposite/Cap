import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const capability = vi.hoisted(() => ({ available: true }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		ASSEMBLY_API_KEY: capability.available ? "synthetic" : undefined,
	}),
}));

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	db: vi.fn(),
	transcript: vi.fn(),
	publication: vi.fn(),
	artifact: vi.fn(),
	legacy: vi.fn(),
	flag: vi.fn(),
	pro: vi.fn(),
	storage: vi.fn(),
	head: vi.fn(),
}));

vi.mock("@cap/web-backend", () => ({
	Storage: { getAccessForVideo: mocks.storage },
}));
vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));
const tables = vi.hoisted(() => ({
	organizations: { id: "organization", settings: "settings" },
	videos: { id: "video" },
	videoUploads: { videoId: "upload" },
	editRevision: { revisionId: "revision" },
}));
vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.user }));
vi.mock("@cap/database/schema", () => tables);
vi.mock("@cap/utils", () => ({ userIsPro: mocks.pro }));
vi.mock("@/actions/videos/get-edit-transcript", () => ({
	getEditTranscript: mocks.transcript,
}));
vi.mock("@/lib/revision-media-grant", () => ({
	readPublication: mocks.publication,
	readArtifactReady: mocks.artifact,
}));
vi.mock("@/lib/flagged-unedited", () => ({ loadEligibleLegacy: mocks.legacy }));
vi.mock("@/lib/instant-finish-flag", () => ({
	isInstantFinishEnabledForOwner: mocks.flag,
}));

import { getEditReadiness } from "../../actions/videos/get-edit-readiness";

let video: Record<string, unknown>;
let upload: Record<string, unknown> | undefined;
let revision: Record<string, unknown>;
beforeEach(() => {
	capability.available = true;
	video = {
		id: "video",
		ownerId: "owner",
		orgId: "organization",
		name: "Recording",
		public: false,
		storageIntegrationId: null,
		folderId: null,
		source: { type: "webMP4" },
		duration: 20,
		width: 100,
		height: 100,
		fps: 30,
		bucket: null,
		transcriptionStatus: "PROCESSING",
		updatedAt: new Date(0),
		createdAt: new Date(0),
		metadata: null,
	};
	upload = undefined;
	revision = {
		revisionId: "rev",
		videoId: "video",
		generation: 2,
		state: "CURRENT",
	};
	mocks.user.mockResolvedValue({ id: "owner" });
	mocks.pro.mockReturnValue(true);
	mocks.flag.mockReturnValue(false);
	mocks.legacy.mockResolvedValue(true);
	mocks.storage.mockImplementation(() =>
		Effect.succeed([{ headObject: mocks.head }]),
	);
	mocks.head.mockImplementation(() => Effect.succeed({ ContentLength: 123 }));
	mocks.publication.mockResolvedValue({
		currentRevisionId: "rev",
		currentGeneration: 2,
		generation: 3,
		publicationEpoch: 4,
		policyEpoch: 5,
	});
	mocks.artifact.mockResolvedValue(true);
	mocks.transcript.mockResolvedValue({
		status: "ready",
		transcript: { words: [{ text: "synthetic" }] },
	});
	mocks.db.mockImplementation(() => ({
		select: () => ({
			from: (table: unknown) => ({
				where: async () =>
					table === tables.videos
						? [video]
						: table === tables.videoUploads
							? upload
								? [upload]
								: []
							: [revision],
			}),
		}),
	}));
});

describe("owner-only read-only projection", () => {
	it.each([false, true])(
		"requires published metadata for legacy flag=%s",
		async (flag) => {
			mocks.flag.mockReturnValue(flag);
			mocks.publication.mockResolvedValue(null);
			for (const metadata of [undefined, 0]) {
				mocks.head.mockImplementation(() =>
					Effect.succeed({ ContentLength: metadata }),
				);
				const result = await getEditReadiness("video" as never);
				expect(
					result.status === "ready" && result.readiness.playbackAdmission,
				).toBe(false);
			}
			mocks.head.mockImplementation(() => Effect.fail(new Error("unreadable")));
			const unreadable = await getEditReadiness("video" as never);
			expect(
				unreadable.status === "ready" && unreadable.readiness.playbackAdmission,
			).toBe(false);
			mocks.head.mockImplementation(() =>
				Effect.succeed({ ContentLength: 123 }),
			);
			const valid = await getEditReadiness("video" as never);
			expect(
				valid.status === "ready" && valid.readiness.playbackAdmission,
			).toBe(true);
			expect(mocks.head).toHaveBeenCalledWith("owner/video/result.mp4");
			expect(mocks.storage.mock.calls[0]?.[0]).toMatchObject({
				ownerId: "owner",
				bucketId: Option.none(),
				public: false,
			});
		},
	);
	it("reports unavailable capability instead of indefinite null waiting", async () => {
		capability.available = false;
		video.transcriptionStatus = null;
		const result = await getEditReadiness("video" as never);
		expect(result.status === "ready" && result.readiness.transcriptLabel).toBe(
			"Transcript unavailable",
		);
		expect(result.status === "ready" && result.readiness.poll).toBe(false);
	});
	it("denies unauthenticated before database/artifact reads", async () => {
		mocks.user.mockResolvedValue(null);
		expect(await getEditReadiness("video" as never)).toEqual({
			status: "unavailable",
		});
		expect(mocks.db).not.toHaveBeenCalled();
		expect(mocks.storage).not.toHaveBeenCalled();
		expect(mocks.transcript).not.toHaveBeenCalled();
	});
	it("conceals nonowners before publication/transcript reads", async () => {
		video.ownerId = "other";
		expect(await getEditReadiness("video" as never)).toEqual({
			status: "unavailable",
		});
		expect(mocks.publication).not.toHaveBeenCalled();
		expect(mocks.storage).not.toHaveBeenCalled();
		expect(mocks.transcript).not.toHaveBeenCalled();
	});
	it("separates admitted video from pending transcript", async () => {
		const result = await getEditReadiness("video" as never);
		expect(result.status).toBe("ready");
		if (result.status !== "ready") throw new Error("missing readiness");
		expect(result.readiness.manualEditing).toBe(true);
		expect(result.readiness.transcriptUsable).toBe(false);
		expect(result.readiness.playbackVerified).toBe(false);
		expect(mocks.transcript).not.toHaveBeenCalled();
	});
	it.each(["missing", "error", "processing"])(
		"does not promote COMPLETE with %s sidecar",
		async (status) => {
			video.transcriptionStatus = "COMPLETE";
			mocks.transcript.mockResolvedValue({ status });
			const result = await getEditReadiness("video" as never);
			expect(
				result.status === "ready" && result.readiness.transcriptUsable,
			).toBe(false);
		},
	);
	it("returns no transcript content for accepted empty COMPLETE", async () => {
		video.transcriptionStatus = "COMPLETE";
		mocks.transcript.mockResolvedValue({
			status: "ready",
			transcript: { words: [] },
		});
		const result = await getEditReadiness("video" as never);
		expect(result.status === "ready" && result.readiness.transcriptLabel).toBe(
			"No speech detected",
		);
		expect(JSON.stringify(result)).not.toContain("words");
	});
	it("keeps processing100 out of the editor", async () => {
		upload = { phase: "processing", processingProgress: 100 };
		const result = await getEditReadiness("video" as never);
		expect(result.status === "ready" && result.readiness.manualEditing).toBe(
			false,
		);
	});
	it("prioritizes recorded processingError over retained phase and progress100", async () => {
		upload = {
			phase: "processing",
			processingProgress: 100,
			processingError: "private failure details",
		};
		video.transcriptionStatus = null;
		const result = await getEditReadiness("video" as never);
		if (result.status !== "ready") throw new Error("missing readiness");
		expect(result.readiness.videoState).toBe("failed");
		expect(result.readiness.videoLabel).toBe("Video processing failed");
		expect(result.readiness.playbackAdmission).toBe(false);
		expect(result.readiness.manualEditing).toBe(false);
		expect(result.readiness.poll).toBe(false);
		expect(JSON.stringify(result)).not.toContain("private failure details");
		expect(mocks.storage).not.toHaveBeenCalled();
	});
	it("requires all current revision artifacts and never falls back from a current pointer", async () => {
		mocks.flag.mockReturnValue(true);
		mocks.artifact.mockResolvedValue(false);
		const result = await getEditReadiness("video" as never);
		expect(
			result.status === "ready" && result.readiness.playbackAdmission,
		).toBe(false);
		expect(mocks.legacy).not.toHaveBeenCalled();
	});
	it("admits a committed revision even with a newer allocated draft", async () => {
		mocks.flag.mockReturnValue(true);
		const result = await getEditReadiness("video" as never);
		expect(
			result.status === "ready" && result.readiness.playbackAdmission,
		).toBe(true);
		expect(mocks.artifact.mock.calls.map((call) => call[1])).toEqual([
			"playlist",
			"init",
			"seg0",
			"playlist",
			"init",
			"seg0",
		]);
	});
	it("rejects a changed epoch across transcript reads", async () => {
		mocks.flag.mockReturnValue(true);
		video.transcriptionStatus = "COMPLETE";
		mocks.publication
			.mockResolvedValueOnce({
				currentRevisionId: "rev",
				currentGeneration: 2,
				publicationEpoch: 4,
				policyEpoch: 5,
			})
			.mockResolvedValueOnce({
				currentRevisionId: "rev",
				currentGeneration: 2,
				publicationEpoch: 5,
				policyEpoch: 5,
			});
		expect(await getEditReadiness("video" as never)).toEqual({
			status: "unavailable",
		});
	});
});

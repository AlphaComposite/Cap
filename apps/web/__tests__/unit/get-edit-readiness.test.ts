import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEditSourceKey } from "../../lib/video-edit-processing";

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
	query: vi.fn(),
	liveRead: vi.fn(),
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
	sourceObject: { videoId: "sourceObject" },
	sourceRelocation: { videoId: "sourceRelocation" },
	videoEdits: { videoId: "videoEdit" },
	revisionOutbox: { videoId: "outbox" },
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
let sourceRows: Array<Record<string, unknown>> = [];
let relocationRows: Array<Record<string, unknown>> = [];
let editRows: Array<Record<string, unknown>> = [];
let liveRows: Array<Record<string, unknown>> = [];
let outboxRows: Array<Record<string, unknown>> = [];
const privateSha = "ab".repeat(32);
const privateKey = "private/source/video/opaque";
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
	sourceRows = [];
	relocationRows = [];
	editRows = [];
	liveRows = [];
	outboxRows = [];
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
			from: (table: unknown) => {
				mocks.query(table);
				return {
					where: async () =>
						table === tables.videos
							? [video]
							: table === tables.videoUploads
								? upload
									? [upload]
									: []
								: table === tables.sourceObject
									? sourceRows
									: table === tables.sourceRelocation
										? relocationRows
										: table === tables.videoEdits
											? editRows
											: table === tables.revisionOutbox
												? outboxRows
												: [revision],
				};
			},
		}),
		execute: async () => {
			mocks.liveRead();
			return liveRows;
		},
	}));
});

describe("owner-only read-only projection", () => {
	it("reads current playback artifacts once and uses a narrower identity fence", async () => {
		mocks.flag.mockReturnValue(true);
		video.transcriptionStatus = "COMPLETE";
		video.metadata = { aiGenerationStatus: "PROCESSING" };
		const result = await getEditReadiness("video" as never, false);
		expect(result.status).toBe("ready");
		expect(mocks.transcript).not.toHaveBeenCalled();
		expect(
			mocks.query.mock.calls.filter(
				([table]) => table === tables.revisionOutbox,
			),
		).toHaveLength(1);
		expect(mocks.artifact).toHaveBeenCalledTimes(3);
		expect(mocks.publication).toHaveBeenCalledTimes(2);
		expect(
			mocks.query.mock.calls.length +
				mocks.artifact.mock.calls.length +
				mocks.publication.mock.calls.length,
		).toBe(16);
	});

	it("caches legacy admission and S3 checks during preparation, invalidating on source changes", async () => {
		mocks.flag.mockReturnValue(true);
		mocks.publication.mockResolvedValue(null);
		video.name = "preparing playback cache";
		outboxRows = [
			{ job: "source-prepare", payload: { phase: "preparing", attempts: 1 } },
		];
		const read = () => getEditReadiness("video" as never, false);
		const queries = () =>
			mocks.query.mock.calls.length +
			mocks.liveRead.mock.calls.length +
			mocks.publication.mock.calls.length +
			4 * mocks.legacy.mock.calls.length;
		const first = await read();
		expect(first.status === "ready" && first.readiness.playbackAdmission).toBe(
			true,
		);
		expect(queries()).toBe(21);
		expect(mocks.head).toHaveBeenCalledTimes(1);
		expect(mocks.legacy).toHaveBeenCalledTimes(1);
		await read();
		expect(queries()).toBe(38);
		expect(mocks.head).toHaveBeenCalledTimes(1);
		expect(mocks.legacy).toHaveBeenCalledTimes(1);
		sourceRows = [{ videoId: "video", liveKey: "owner/video/changed.mp4" }];
		await read();
		expect(mocks.head).toHaveBeenCalledTimes(2);
		expect(mocks.legacy).toHaveBeenCalledTimes(2);
	});

	it("keeps positive hints advisory after the object disappears with unchanged DB rows", async () => {
		mocks.flag.mockReturnValue(true);
		mocks.publication.mockResolvedValue(null);
		video.name = "deleted playback object";
		sourceRows = [
			{
				liveKey: "owner/video/result.mp4",
				sha256: privateSha,
				relocationState: "LIVE",
				codec: "h264",
				timebase: "1/90000",
				frameMode: "cfr",
				a1Digest: privateSha,
				indexId: "index",
				warmExpiresAt: new Date(Date.now() + 60_000),
			},
		];
		relocationRows = [
			{
				oldKey: "owner/video/result.mp4",
				newKey: privateKey,
				sha256: privateSha,
				state: "COPIED",
			},
		];
		outboxRows = [
			{ job: "source-prepare", payload: { phase: "prepared", attempts: 1 } },
		];
		const initial = await getEditReadiness("video" as never, false);
		expect(initial.status === "ready" && initial.readiness.manualEditing).toBe(
			true,
		);
		mocks.head.mockImplementation(() =>
			Effect.fail(new Error("object missing")),
		);
		const advisory = await getEditReadiness("video" as never, false);
		expect(
			advisory.status === "ready" && advisory.readiness.manualEditing,
		).toBe(true);
		expect(mocks.head).toHaveBeenCalledTimes(1);
		const fresh = await getEditReadiness("video" as never, false, false);
		expect(fresh.status === "ready" && fresh.readiness.playbackAdmission).toBe(
			false,
		);
		expect(fresh.status === "ready" && fresh.readiness.manualEditing).toBe(
			false,
		);
		expect(fresh.status === "ready" && fresh.readiness.editorOpenable).toBe(
			false,
		);
		expect(mocks.head).toHaveBeenCalledTimes(2);
	});

	it.each([false, true])(
		"separates source admission from current playback with warm=%s",
		async (warm) => {
			mocks.flag.mockReturnValue(true);
			sourceRows = [
				{
					liveKey: "owner/video/result.mp4",
					sha256: privateSha,
					relocationState: "LIVE",
					codec: "h264",
					timebase: "1/90000",
					frameMode: "cfr",
					a1Digest: privateSha,
					indexId: "index",
					warmExpiresAt: warm ? new Date(Date.now() + 60_000) : null,
				},
			];
			relocationRows = [
				{
					oldKey: "owner/video/result.mp4",
					newKey: privateKey,
					sha256: privateSha,
					state: "COPIED",
				},
			];
			outboxRows = [
				{
					job: "source-prepare",
					payload: { phase: "prepared", attempts: 1, finished: false },
				},
			];
			const result = await getEditReadiness("video" as never);
			if (result.status !== "ready") throw new Error("missing readiness");
			expect(result.readiness.playbackAdmission).toBe(true);
			expect(result.readiness.editorOpenable).toBe(warm);
			expect(result.readiness.manualEditing).toBe(warm);
			expect(result.readiness.sourcePrepare).toBe("running");
			expect(result.readiness.poll).toBe(true);
		},
	);
	it("reports source exhaustion without inventing a source retry", async () => {
		mocks.flag.mockReturnValue(true);
		outboxRows = [
			{
				job: "source-prepare",
				payload: { exhausted: true, error: "captions unavailable" },
			},
		];
		const result = await getEditReadiness("video" as never);
		if (result.status !== "ready") throw new Error("missing readiness");
		expect(result.readiness.rows[4]).toMatchObject({
			state: "failed",
			reason: "captions unavailable",
		});
		expect(result.readiness.rows[4]?.retry).toBeUndefined();
		expect(result.readiness.editorOpenable).toBe(false);
	});
	it.each([false, true])(
		"requires published metadata for legacy flag=%s",
		async (flag) => {
			mocks.flag.mockReturnValue(flag);
			mocks.publication.mockResolvedValue(null);
			let now = Date.now();
			const clock = vi.spyOn(Date, "now").mockReturnValue(now);
			for (const metadata of [undefined, 0]) {
				mocks.head.mockImplementation(() =>
					Effect.succeed({ ContentLength: metadata }),
				);
				const result = await getEditReadiness("video" as never);
				expect(
					result.status === "ready" && result.readiness.playbackAdmission,
				).toBe(false);
				now += 5000;
				clock.mockReturnValue(now);
			}
			mocks.head.mockImplementation(() => Effect.fail(new Error("unreadable")));
			const unreadable = await getEditReadiness("video" as never);
			expect(
				unreadable.status === "ready" && unreadable.readiness.playbackAdmission,
			).toBe(false);
			now += 5000;
			clock.mockReturnValue(now);
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
			processingError: "Media processing failed",
		};
		video.transcriptionStatus = null;
		const result = await getEditReadiness("video" as never);
		if (result.status !== "ready") throw new Error("missing readiness");
		expect(result.readiness.videoState).toBe("failed");
		expect(result.readiness.videoLabel).toBe("Video processing failed");
		expect(result.readiness.playbackAdmission).toBe(false);
		expect(result.readiness.manualEditing).toBe(false);
		expect(result.readiness.poll).toBe(false);
		expect(result.readiness.rows[1]?.reason).toBe("Media processing failed");
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
		]);
	});
	function requireSourceRow() {
		const row = sourceRows[0];
		if (!row) throw new Error("missing source fixture");
		return row;
	}
	function requireRelocationRow() {
		const row = relocationRows[0];
		if (!row) throw new Error("missing relocation fixture");
		return row;
	}
	function useVerifiedPrivateSource() {
		sourceRows = [
			{
				videoId: "video",
				liveKey: privateKey,
				sha256: privateSha,
				relocationState: "PURGED",
				codec: "h264",
				timebase: "1/90000",
				frameMode: "cfr",
				a1Digest: privateSha,
				indexId: "registered-index",
				warmExpiresAt: new Date(Date.now() + 60_000),
			},
		];
		relocationRows = [
			{
				videoId: "video",
				oldKey: getEditSourceKey("owner", "video"),
				newKey: privateKey,
				sha256: privateSha,
				state: "PURGED",
			},
		];
		liveRows = [{ liveKey: privateKey, sha256: privateSha }];
	}
	it("admits a verified PURGED owner source when viewer legacy excludes it", async () => {
		mocks.flag.mockReturnValue(true);
		mocks.publication.mockResolvedValue(null);
		mocks.legacy.mockResolvedValue(false);
		video.transcriptionStatus = "NO_AUDIO";
		useVerifiedPrivateSource();
		const result = await getEditReadiness("video" as never);
		expect(result.status).toBe("ready");
		if (result.status !== "ready") throw new Error("missing readiness");
		expect(result.readiness.videoState).toBe("processed");
		expect(result.readiness.videoLabel).toBe("Video processed");
		expect(result.readiness.manualEditing).toBe(true);
		expect(result.readiness.transcriptUsable).toBe(false);
		expect(result.readiness.playbackVerified).toBe(false);
		expect(result.readiness.transcriptLabel).toBe("No audio");
		expect(mocks.head).toHaveBeenCalledWith(privateKey);
		expect(mocks.head).not.toHaveBeenCalledWith("owner/video/result.mp4");
		expect(mocks.legacy).toHaveBeenCalled();
	});
	function denied(result: Awaited<ReturnType<typeof getEditReadiness>>) {
		return result.status === "ready" && result.readiness.manualEditing;
	}
	it.each(["ABORTED", "LIVE", "INTENT", "COPIED", "POINTER", "DELETED"])(
		"denies owner admission for %s source state",
		async (state) => {
			mocks.flag.mockReturnValue(true);
			mocks.publication.mockResolvedValue(null);
			mocks.legacy.mockResolvedValue(false);
			useVerifiedPrivateSource();
			requireSourceRow().relocationState = state;
			requireRelocationRow().state = state;
			const result = await getEditReadiness("video" as never);
			expect(denied(result)).toBe(false);
			expect(mocks.head).not.toHaveBeenCalledWith(privateKey);
		},
	);
	it("denies an ambiguous or wrong-video private source", async () => {
		mocks.flag.mockReturnValue(true);
		mocks.publication.mockResolvedValue(null);
		mocks.legacy.mockResolvedValue(false);
		useVerifiedPrivateSource();
		relocationRows.push({
			videoId: "video",
			newKey: "private/source/video/second",
			sha256: privateSha,
			state: "ABORTED",
		});
		const ambiguous = await getEditReadiness("video" as never);
		expect(denied(ambiguous)).toBe(false);
		relocationRows.pop();
		requireSourceRow().videoId = "other";
		const wrongVideo = await getEditReadiness("video" as never);
		expect(denied(wrongVideo)).toBe(false);
		expect(mocks.head).not.toHaveBeenCalledWith(privateKey);
	});
	it("denies malformed, mismatched, or merely private-looking source identity", async () => {
		mocks.flag.mockReturnValue(true);
		mocks.publication.mockResolvedValue(null);
		mocks.legacy.mockResolvedValue(false);
		useVerifiedPrivateSource();
		const bad = "zz".repeat(32);
		requireSourceRow().sha256 = bad;
		requireRelocationRow().sha256 = bad;
		liveRows = [{ liveKey: privateKey, sha256: bad }];
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		useVerifiedPrivateSource();
		requireRelocationRow().sha256 = "cd".repeat(32);
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		const url = "https://example.invalid/private/source/video/opaque";
		useVerifiedPrivateSource();
		requireSourceRow().liveKey = url;
		requireRelocationRow().newKey = url;
		liveRows = [{ liveKey: url, sha256: privateSha }];
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		expect(mocks.head).not.toHaveBeenCalledWith(url);
		expect(mocks.head).not.toHaveBeenCalledWith(privateKey);
	});
	it("denies a verified private source with absent or empty object metadata", async () => {
		mocks.flag.mockReturnValue(true);
		mocks.publication.mockResolvedValue(null);
		mocks.legacy.mockResolvedValue(false);
		useVerifiedPrivateSource();
		mocks.head.mockImplementation(() => Effect.fail(new Error("absent")));
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		mocks.head.mockImplementation(() => Effect.succeed({ ContentLength: 0 }));
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
	});
	it("does not loosen geometry or active-upload denial for a verified private source", async () => {
		mocks.flag.mockReturnValue(true);
		mocks.publication.mockResolvedValue(null);
		mocks.legacy.mockResolvedValue(false);
		useVerifiedPrivateSource();
		video.fps = null;
		const missingFps = await getEditReadiness("video" as never);
		expect(
			missingFps.status === "ready" && missingFps.readiness.videoState,
		).toBe("processed");
		expect(
			missingFps.status === "ready" && missingFps.readiness.videoLabel,
		).toBe("Video preparation unavailable");
		expect(denied(missingFps)).toBe(false);
		video.fps = Number.POSITIVE_INFINITY;
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		video.fps = 30;
		upload = { phase: "uploading" };
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		upload = { phase: "complete", processingError: "retained failure" };
		const failed = await getEditReadiness("video" as never);
		expect(failed.status === "ready" && failed.readiness.videoState).toBe(
			"failed",
		);
		expect(denied(failed)).toBe(false);
		upload = undefined;
		video.metadata = { editProcessing: { startedAt: 1 } };
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		expect(mocks.head).not.toHaveBeenCalled();
	});
	it("does not use a private source to evade a current publication or missing tables", async () => {
		mocks.flag.mockReturnValue(true);
		mocks.artifact.mockResolvedValue(false);
		useVerifiedPrivateSource();
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		expect(mocks.legacy).not.toHaveBeenCalled();
		mocks.publication.mockResolvedValue("missing_table");
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		expect(mocks.head).not.toHaveBeenCalledWith(privateKey);
	});
	it("keeps a changed private source from admitting across the freshness reads", async () => {
		mocks.flag.mockReturnValue(true);
		mocks.publication.mockResolvedValue(null);
		mocks.legacy.mockResolvedValue(false);
		useVerifiedPrivateSource();
		let sourceReads = 0;
		mocks.db.mockImplementation(() => ({
			select: () => ({
				from: (table: unknown) => ({
					where: async () => {
						if (table === tables.videos) return [video];
						if (table === tables.videoUploads) return upload ? [upload] : [];
						if (table === tables.sourceObject) {
							sourceReads += 1;
							return sourceReads === 1
								? sourceRows
								: [{ ...requireSourceRow(), sha256: "cd".repeat(32) }];
						}
						if (table === tables.sourceRelocation) return relocationRows;
						if (table === tables.videoEdits) return editRows;
						return [revision];
					},
				}),
			}),
			execute: async () => liveRows,
		}));
		expect(await getEditReadiness("video" as never)).toEqual({
			status: "unavailable",
		});
	});
	it("preserves owner and pro denial for a verified private source", async () => {
		mocks.flag.mockReturnValue(true);
		mocks.publication.mockResolvedValue(null);
		mocks.legacy.mockResolvedValue(false);
		useVerifiedPrivateSource();
		video.ownerId = "other";
		expect(await getEditReadiness("video" as never)).toEqual({
			status: "unavailable",
		});
		video.ownerId = "owner";
		mocks.pro.mockReturnValue(false);
		const unpaid = await getEditReadiness("video" as never);
		expect(unpaid.status).toBe("ready");
		if (unpaid.status !== "ready") throw new Error("missing readiness");
		expect(unpaid.readiness.manualEditing).toBe(false);
		expect(unpaid.readiness.playbackVerified).toBe(false);
		video.isScreenshot = true;
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
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
	function unrelatedRollbacks() {
		return [
			{
				videoId: "video",
				oldKey: "owner/video/result.mp4",
				newKey: "private/rollback/video/result",
				sha256: privateSha,
				state: "PURGED",
			},
			{
				videoId: "video",
				oldKey: "owner/video/raw-upload.mp4",
				newKey: "private/rollback/video/raw",
				sha256: privateSha,
				state: "PURGED",
			},
		];
	}
	function admitOwner() {
		mocks.flag.mockReturnValue(true);
		mocks.publication.mockResolvedValue(null);
		mocks.legacy.mockResolvedValue(false);
		video.transcriptionStatus = "NO_AUDIO";
		useVerifiedPrivateSource();
	}
	it("admits one PURGED registered original beside unrelated per-video rollback journals", async () => {
		admitOwner();
		relocationRows.push(...unrelatedRollbacks());
		const result = await getEditReadiness("video" as never);
		expect(result.status === "ready" && result.readiness.manualEditing).toBe(
			true,
		);
		expect(mocks.head).toHaveBeenCalledWith(privateKey);
		expect(mocks.head).not.toHaveBeenCalledWith("owner/video/result.mp4");
	});
	it("admits a registered runtime original that is not source/original.mp4 among unrelated journals", async () => {
		admitOwner();
		const runtimeKey = "owner/video/captures/take.mp4";
		editRows = [{ videoId: "video", sourceKey: runtimeKey }];
		requireRelocationRow().oldKey = runtimeKey;
		relocationRows.push(...unrelatedRollbacks());
		const result = await getEditReadiness("video" as never);
		expect(result.status === "ready" && result.readiness.manualEditing).toBe(
			true,
		);
		expect(mocks.head).toHaveBeenCalledWith(privateKey);
	});
	it("denies a private key whose journal oldKey is not the registered original", async () => {
		admitOwner();
		requireRelocationRow().oldKey = "owner/video/captures/take.mp4";
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		expect(mocks.head).not.toHaveBeenCalledWith(privateKey);
	});
	it("denies a cross-owner original journal even when the private key matches", async () => {
		admitOwner();
		requireRelocationRow().oldKey = "other/video/source/original.mp4";
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		expect(mocks.head).not.toHaveBeenCalledWith(privateKey);
	});
	it("does not ignore a matching private key with the wrong checksum", async () => {
		admitOwner();
		relocationRows.push(...unrelatedRollbacks());
		requireRelocationRow().sha256 = "cd".repeat(32);
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		expect(mocks.head).not.toHaveBeenCalledWith(privateKey);
	});
	it("denies duplicate matching original journals", async () => {
		admitOwner();
		relocationRows.push({
			videoId: "video",
			oldKey: getEditSourceKey("owner", "video"),
			newKey: privateKey,
			sha256: privateSha,
			state: "PURGED",
		});
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		expect(mocks.head).not.toHaveBeenCalledWith(privateKey);
	});
	it("denies a journal whose destination video does not match", async () => {
		admitOwner();
		relocationRows.push({
			videoId: "video",
			oldKey: "owner/video/result.mp4",
			newKey: "private/rollback/other/result",
			sha256: privateSha,
			state: "PURGED",
		});
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
	});
	it("denies a relocation row for a different video", async () => {
		admitOwner();
		relocationRows.push({
			videoId: "other",
			oldKey: "owner/other/result.mp4",
			newKey: "private/rollback/other/result",
			sha256: privateSha,
			state: "PURGED",
		});
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
	});
	it("denies an ABORTED original even when unrelated rollbacks are PURGED", async () => {
		admitOwner();
		requireRelocationRow().state = "ABORTED";
		relocationRows.push(...unrelatedRollbacks());
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		expect(mocks.head).not.toHaveBeenCalledWith(privateKey);
	});
	it("rejects a selected original state change even when relocation count is unchanged", async () => {
		admitOwner();
		relocationRows.push(...unrelatedRollbacks());
		let relocationReads = 0;
		mocks.db.mockImplementation(() => ({
			select: () => ({
				from: (table: unknown) => ({
					where: async () => {
						if (table === tables.videos) return [video];
						if (table === tables.videoUploads) return upload ? [upload] : [];
						if (table === tables.sourceObject) return sourceRows;
						if (table === tables.videoEdits) return editRows;
						if (table === tables.sourceRelocation) {
							relocationReads += 1;
							if (relocationReads === 1) return relocationRows;
							return relocationRows.map((row, index) =>
								index === 0 ? { ...row, state: "ABORTED" } : row,
							);
						}
						return [revision];
					},
				}),
			}),
			execute: async () => liveRows,
		}));
		expect(await getEditReadiness("video" as never)).toEqual({
			status: "unavailable",
		});
	});
	it("rejects a selected original key change across freshness reads", async () => {
		admitOwner();
		const runtimeKey = "owner/video/captures/take.mp4";
		editRows = [{ videoId: "video", sourceKey: runtimeKey }];
		let relocationReads = 0;
		mocks.db.mockImplementation(() => ({
			select: () => ({
				from: (table: unknown) => ({
					where: async () => {
						if (table === tables.videos) return [video];
						if (table === tables.videoUploads) return upload ? [upload] : [];
						if (table === tables.sourceObject) return sourceRows;
						if (table === tables.videoEdits) return editRows;
						if (table === tables.sourceRelocation) {
							relocationReads += 1;
							return [
								{
									...requireRelocationRow(),
									oldKey:
										relocationReads === 1
											? getEditSourceKey("owner", "video")
											: runtimeKey,
								},
							];
						}
						return [revision];
					},
				}),
			}),
			execute: async () => liveRows,
		}));
		expect(await getEditReadiness("video" as never)).toEqual({
			status: "unavailable",
		});
	});
	it("webMP4 result provenance admits NO_AUDIO PURGED result.mp4 original at the registered private source", async () => {
		admitOwner();
		requireRelocationRow().oldKey = "owner/video/result.mp4";
		const result = await getEditReadiness("video" as never);
		expect
			.soft(result.status === "ready" && result.readiness.manualEditing)
			.toBe(true);
		expect
			.soft(result.status === "ready" && result.readiness.videoLabel)
			.toBe("Video processed");
		expect.soft(mocks.head).toHaveBeenCalledWith(privateKey);
		expect(mocks.head).not.toHaveBeenCalledWith("owner/video/result.mp4");
	});
	it("webMP4 result provenance denies desktopMP4", async () => {
		admitOwner();
		video.source = { type: "desktopMP4" };
		requireRelocationRow().oldKey = "owner/video/result.mp4";
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		expect(mocks.head).not.toHaveBeenCalledWith(privateKey);
		expect(mocks.head).not.toHaveBeenCalledWith("owner/video/result.mp4");
	});
	it("webMP4 result provenance denies mismatched private destination", async () => {
		admitOwner();
		requireRelocationRow().oldKey = "owner/video/result.mp4";
		requireRelocationRow().newKey = "private/source/video/other";
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		expect(mocks.head).not.toHaveBeenCalledWith(privateKey);
		expect(mocks.head).not.toHaveBeenCalledWith("private/source/video/other");
		expect(mocks.head).not.toHaveBeenCalledWith("owner/video/result.mp4");
	});
	it("webMP4 result provenance denies ABORTED", async () => {
		admitOwner();
		requireRelocationRow().oldKey = "owner/video/result.mp4";
		requireRelocationRow().state = "ABORTED";
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		expect(mocks.head).not.toHaveBeenCalledWith(privateKey);
		expect(mocks.head).not.toHaveBeenCalledWith("owner/video/result.mp4");
	});
	it("webMP4 result provenance denies cross-owner oldKey", async () => {
		admitOwner();
		requireRelocationRow().oldKey = "other/video/result.mp4";
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		expect(mocks.head).not.toHaveBeenCalledWith(privateKey);
		expect(mocks.head).not.toHaveBeenCalledWith("other/video/result.mp4");
		expect(mocks.head).not.toHaveBeenCalledWith("owner/video/result.mp4");
	});
	it("webMP4 result provenance denies checksum mismatch", async () => {
		admitOwner();
		requireRelocationRow().oldKey = "owner/video/result.mp4";
		requireRelocationRow().sha256 = "cd".repeat(32);
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		expect(mocks.head).not.toHaveBeenCalledWith(privateKey);
		expect(mocks.head).not.toHaveBeenCalledWith("owner/video/result.mp4");
	});
	it("webMP4 result provenance denies duplicate originals", async () => {
		admitOwner();
		requireRelocationRow().oldKey = "owner/video/result.mp4";
		relocationRows.push({
			videoId: "video",
			oldKey: "owner/video/result.mp4",
			newKey: privateKey,
			sha256: privateSha,
			state: "PURGED",
		});
		expect(denied(await getEditReadiness("video" as never))).toBe(false);
		expect(mocks.head).not.toHaveBeenCalledWith(privateKey);
		expect(mocks.head).not.toHaveBeenCalledWith("owner/video/result.mp4");
	});
	it("webMP4 result provenance admits web original beside unrelated rollback rows", async () => {
		admitOwner();
		requireRelocationRow().oldKey = "owner/video/result.mp4";
		relocationRows.push(...unrelatedRollbacks());
		const result = await getEditReadiness("video" as never);
		expect
			.soft(result.status === "ready" && result.readiness.manualEditing)
			.toBe(true);
		expect
			.soft(result.status === "ready" && result.readiness.videoLabel)
			.toBe("Video processed");
		expect.soft(mocks.head).toHaveBeenCalledWith(privateKey);
		expect(mocks.head).not.toHaveBeenCalledWith("owner/video/result.mp4");
	});
});

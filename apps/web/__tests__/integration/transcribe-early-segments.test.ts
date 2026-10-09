import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assemblyAIEditResponse } from "../fixtures/assemblyai-edit-response";

const mocks = vi.hoisted(() => ({
	transcribe: vi.fn(),
	putObject: vi.fn(),
	deleteObject: vi.fn(),
	getObject: vi.fn(),
	getInternalSignedObjectUrl: vi.fn(),
	startAiGeneration: vi.fn(),
	probeVideo: vi.fn(),
	resolveLiveOriginal: vi.fn(),
	startWorkflow: vi.fn(),
	updates: [] as Record<string, unknown>[],
}));

const schemaMocks = vi.hoisted(() => ({
	videos: {
		id: "videos.id",
		metadata: "videos.metadata",
		transcriptionStatus: "videos.transcriptionStatus",
		updatedAt: "videos.updatedAt",
	},
	organizations: { id: "organizations.id" },
	users: { id: "users.id" },
	sourceRelocation: { videoId: "sourceRelocation.videoId" },
	videoUploads: {
		videoId: "videoUploads.videoId",
		rawFileKey: "videoUploads.rawFileKey",
	},
	videoEdits: {
		videoId: "videoEdits.videoId",
		editSpec: "videoEdits.editSpec",
	},
}));

const videoRow = vi.hoisted(() => ({
	id: "video-123",
	ownerId: "user-456",
	duration: null as number | null,
	settings: null,
	source: { type: "desktopSegments" },
	isScreenshot: false,
	transcriptionStatus: null,
	updatedAt: new Date("2026-08-01T00:00:00.000Z"),
	metadata: {},
}));

const state = vi.hoisted(() => ({
	editRows: [] as unknown[],
	fakeAudioPath: "",
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		ASSEMBLY_API_KEY: "test-assembly-api-key",
		NEXTAUTH_SECRET: "test-secret-with-enough-entropy",
	}),
}));

vi.mock("@cap/database/schema", () => schemaMocks);

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: unknown) => {
				if (table === schemaMocks.videoUploads) {
					return { where: () => ({ limit: async () => [] }) };
				}
				if (
					table === schemaMocks.sourceRelocation ||
					table === schemaMocks.users
				) {
					return { where: async () => [] };
				}
				if (table === schemaMocks.videoEdits) {
					return { where: async () => state.editRows };
				}
				return {
					leftJoin: () => ({
						where: async () => [{ video: videoRow, orgSettings: null }],
					}),
					where: async () => [videoRow],
				};
			},
		}),
		transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
			const { db } = await import("@cap/database");
			return fn(db());
		},
		update: () => ({
			set: (values: Record<string, unknown>) => {
				mocks.updates.push(values);
				return { where: async () => [{ affectedRows: 1 }] };
			},
		}),
	}),
}));

vi.mock("drizzle-orm", () => ({
	and: (...conditions: unknown[]) => ({ conditions }),
	eq: (field: unknown, value: unknown) => ({ field, value }),
	isNull: (field: unknown) => ({ isNull: field }),
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings,
		values,
	}),
}));

vi.mock("server-only", () => ({}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));

vi.mock("workflow/api", () => ({
	start: mocks.startWorkflow,
}));

vi.mock("assemblyai", () => ({
	AssemblyAI: class {
		transcripts = { transcribe: mocks.transcribe };
	},
}));

vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () => ({
			pipe: (runner: (value: unknown) => unknown) =>
				runner([
					{
						putObject: mocks.putObject,
						deleteObject: mocks.deleteObject,
						getObject: mocks.getObject,
						getInternalSignedObjectUrl: mocks.getInternalSignedObjectUrl,
					},
				]),
		}),
	},
}));

vi.mock("@/lib/source-prepare-worker", () => ({
	enqueueSourceCaptionsAfterTranscript: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: (value: unknown) => Promise.resolve(value),
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));

vi.mock("@/lib/private-source-read", () => ({
	resolveLiveOriginal: mocks.resolveLiveOriginal,
}));

vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: () => false,
}));

vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));

vi.mock("@/lib/media-client", () => ({
	isMediaServerConfigured: () => true,
	probeVideoViaMediaServer: mocks.probeVideo,
	extractAudioViaMediaServer: async () => Buffer.from("audio"),
	checkHasAudioTrackViaMediaServer: async () => true,
}));

vi.mock("@/lib/audio-extract", () => ({
	checkHasAudioTrack: async () => true,
	extractAudioFromUrl: async () => ({
		filePath: state.fakeAudioPath,
		cleanup: async () => {},
	}),
}));

vi.mock("@/lib/audio-enhance", () => ({
	ENHANCED_AUDIO_CONTENT_TYPE: "audio/mpeg",
	ENHANCED_AUDIO_EXTENSION: "mp3",
	enhanceAudioFromUrl: async () => Buffer.from(""),
}));

vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: mocks.startAiGeneration,
}));

function pipeValue(value: unknown) {
	return { pipe: (runner: (input: unknown) => unknown) => runner(value) };
}

const manifest = {
	version: 5,
	video_init_uploaded: true,
	audio_init_uploaded: true,
	video_segments: [
		{ index: 1, duration: 2 },
		{ index: 2, duration: 2 },
	],
	audio_segments: [
		{ index: 1, duration: 2 },
		{ index: 2, duration: 2.5 },
	],
	is_complete: true,
};

describe("transcribeVideoWorkflow earlyFromSegments", () => {
	beforeEach(async () => {
		mocks.updates.length = 0;
		state.editRows = [];
		videoRow.duration = null;
		videoRow.source = { type: "desktopSegments" };
		mocks.transcribe.mockReset();
		mocks.startWorkflow.mockReset();
		mocks.startWorkflow.mockResolvedValue(undefined);
		mocks.transcribe.mockResolvedValue({
			...assemblyAIEditResponse,
			audio_duration: 4,
		});
		mocks.resolveLiveOriginal.mockReset();
		mocks.resolveLiveOriginal.mockResolvedValue(null);
		mocks.probeVideo.mockReset();
		mocks.probeVideo.mockResolvedValue({
			audioCodec: "aac",
			videoCodec: "h264",
			duration: 4,
			audioChannels: 2,
			sampleRate: 48_000,
		});
		mocks.putObject.mockReset();
		mocks.deleteObject.mockReset();
		mocks.getObject.mockReset();
		mocks.getInternalSignedObjectUrl.mockReset();
		mocks.putObject.mockImplementation(() => pipeValue(undefined));
		mocks.deleteObject.mockImplementation(() => pipeValue(undefined));
		mocks.getObject.mockImplementation(() =>
			pipeValue(Option.some(JSON.stringify(manifest))),
		);
		mocks.getInternalSignedObjectUrl.mockImplementation((key: string) =>
			pipeValue(`https://storage.test/${key}`),
		);
		mocks.startAiGeneration.mockResolvedValue({ success: true, message: "ok" });

		state.fakeAudioPath = join(tmpdir(), `fake-audio-${randomUUID()}.mp3`);
		await fs.writeFile(state.fakeAudioPath, "mp3-bytes");

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes("result.mp4") || url.includes("rawFileKey")) {
					return { ok: false, status: 404, statusText: "Not Found" };
				}
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					arrayBuffer: async () => new TextEncoder().encode("seg").buffer,
				};
			}),
		);
	});

	afterEach(() => vi.unstubAllEnvs());

	it.each([false, true])(
		"transcribes straight from segment audio before any mux exists (flagged=%s)",
		async (flagged) => {
			vi.stubEnv("CAP_INSTANT_FINISH_OWNERS", flagged ? "user-456" : "");
			const { transcribeVideoWorkflow } = await import(
				"@/workflows/transcribe"
			);

			const result = await transcribeVideoWorkflow({
				videoId: "video-123",
				userId: "user-456",
				aiGenerationEnabled: false,
				earlyFromSegments: true,
			});

			expect(result.success).toBe(true);
			expect(mocks.transcribe).toHaveBeenCalledTimes(1);

			const signedKeys = mocks.getInternalSignedObjectUrl.mock.calls.map(
				(call) => call[0],
			);
			expect(signedKeys).toContain(
				"user-456/video-123/segments/audio/init.mp4",
			);
			expect(signedKeys).toContain(
				"user-456/video-123/segments/audio/segment_001.m4s",
			);
			expect(signedKeys).toContain(
				"user-456/video-123/segments/audio/segment_002.m4s",
			);
			// never touches the video track
			expect(signedKeys.join()).not.toContain("segments/video");

			const writtenKeys = mocks.putObject.mock.calls.map((call) => call[0]);
			const audioKey = flagged
				? "private/source/video-123/audio-temp.mp3"
				: "user-456/video-123/audio-temp.mp3";
			expect(writtenKeys).toContain(audioKey);
			expect(signedKeys).toContain(audioKey);
			expect(mocks.deleteObject).toHaveBeenCalledWith(audioKey);
			expect(writtenKeys).toContain("user-456/video-123/transcription.vtt");
			expect(writtenKeys).toContain(
				"user-456/video-123/transcription.edit.v3.json",
			);

			// duration falls back to the manifest sum (2s + 2.5s) when the video row
			// has no duration yet (it is only set by the post-mux webhook)
			const { parseEditTranscript } = await import("@/lib/edit-transcript");
			const { decryptEditTranscriptObject } = await import(
				"@/lib/edit-transcript-storage"
			);
			const write = mocks.putObject.mock.calls.find(
				(call) => call[0] === "user-456/video-123/transcription.edit.v3.json",
			);
			const stored = parseEditTranscript(
				decryptEditTranscriptObject(
					write?.[1] as string,
					"user-456",
					"video-123",
				) ?? "",
			);
			expect(stored?.durationMs).toBe(4500);

			expect(mocks.updates).toContainEqual({ transcriptionStatus: "COMPLETE" });
			expect(mocks.updates).not.toContainEqual({
				transcriptionStatus: "ERROR",
			});
			// the provisional live transcript is superseded by the canonical one
			expect(mocks.deleteObject.mock.calls.map((call) => call[0])).toContain(
				flagged
					? "private/source/video-123/transcription.live.json"
					: "user-456/video-123/transcription.live.json",
			);
		},
	);

	it("runs the post-mux pass on the registered private source when a signed segment disappears", async () => {
		vi.stubEnv("CAP_INSTANT_FINISH_OWNERS", "user-456");
		const liveKey = "private/source/video-123/original";
		mocks.resolveLiveOriginal.mockResolvedValue({ liveKey });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input) => ({
				arrayBuffer: async () => new TextEncoder().encode("audio").buffer,
				ok:
					String(input).includes(liveKey) ||
					String(input).includes("/audio-temp.mp3"),
				status:
					String(input).includes(liveKey) ||
					String(input).includes("/audio-temp.mp3")
						? 200
						: 404,
			})),
		);
		// Execute the queued workflow, not just assert that start was requested.
		mocks.startWorkflow.mockImplementation(async (workflow, [payload]) =>
			workflow(payload),
		);
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const result = await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
			earlyFromSegments: true,
		});
		expect(result.message).toContain("Segment 0 not accessible: 404");
		expect(mocks.startWorkflow).toHaveBeenCalledTimes(1);
		expect(mocks.probeVideo).toHaveBeenCalledWith(
			`https://storage.test/${liveKey}`,
		);
		expect(mocks.transcribe).toHaveBeenCalledTimes(1);
		expect(mocks.updates).toContainEqual({ transcriptionStatus: "COMPLETE" });
		expect(mocks.updates).not.toContainEqual({ transcriptionStatus: "ERROR" });
		expect(mocks.putObject.mock.calls.map(([key]) => key)).toContain(
			"private/source/video-123/audio-temp.mp3",
		);
		expect(
			mocks.putObject.mock.calls.some(([key]) => key.includes("/segments/")),
		).toBe(false);
	});

	it.each([
		{ flagged: true, inventoryDuringChunk: true },
		{ flagged: true, inventoryDuringChunk: false },
		{ flagged: false, inventoryDuringChunk: false },
	])(
		"keeps accumulated live words and uses one artifact key (%j)",
		async ({ flagged, inventoryDuringChunk }) => {
			vi.stubEnv("CAP_INSTANT_FINISH_OWNERS", flagged ? "user-456" : "");
			const core = await import("@/lib/live-transcribe-core");
			const { assertFinishInventoryClear } = await import(
				"@/lib/source-relocation"
			);
			const prefix = "user-456/video-123/";
			const key = flagged
				? "private/source/video-123/transcription.live.json"
				: `${prefix}transcription.live.json`;
			const prior = core.applyChunkToLiveTranscript(
				core.createEmptyLiveTranscript("now"),
				{
					startMs: 0,
					durationMs: 2000,
					lastAudioSegmentIndex: 1,
					words: core.offsetChunkWords(
						[{ text: "accumulated", start: 0, end: 1000 }],
						0,
						2000,
					),
					languageCode: "en",
					nowIso: "now",
				},
			);
			const objects = new Map([
				[`${prefix}segments/manifest.json`, JSON.stringify(manifest)],
				[key, JSON.stringify(prior)],
			]);
			const listed = () =>
				[...objects.keys()].filter((name) => name.startsWith(prefix));
			mocks.getObject.mockImplementation((name) =>
				pipeValue(
					objects.has(name) ? Option.some(objects.get(name)) : Option.none(),
				),
			);
			mocks.putObject.mockImplementation((name, body) => {
				objects.set(name, body);
				return pipeValue(undefined);
			});
			mocks.deleteObject.mockImplementation((name) => {
				objects.delete(name);
				return pipeValue(undefined);
			});
			mocks.transcribe.mockImplementation(async () => {
				// The provider already has the chunk; inventory finishes before its late PUT.
				if (inventoryDuringChunk) {
					for (const name of listed()) objects.delete(name);
					assertFinishInventoryClear(listed(), prefix);
				}
				return {
					status: "completed",
					language_code: "en",
					words: [{ text: "late", start: 0, end: 1000 }],
				};
			});
			const { liveTranscribeWorkflow } = await import(
				"@/workflows/live-transcribe"
			);
			const result = await liveTranscribeWorkflow({
				videoId: "video-123",
				userId: "user-456",
			});
			expect(mocks.putObject.mock.calls.map(([name]) => name)).toContain(key);
			if (inventoryDuringChunk) {
				expect(listed()).toEqual([]);
				expect(() =>
					assertFinishInventoryClear(listed(), prefix),
				).not.toThrow();
				expect(objects.has(`${prefix}transcription.live.json`)).toBe(false);
				expect(
					core
						.parseLiveTranscript(objects.get(key)!)
						?.words.map((word) => word.text),
				).toEqual(["accumulated", "late"]);
			} else {
				expect(result.message).toBe("Live transcription promoted to canonical");
				expect(objects.get(`${prefix}transcription.vtt`)).toContain(
					"accumulated",
				);
				expect(objects.get(`${prefix}transcription.vtt`)).toContain("late");
				expect(mocks.deleteObject).toHaveBeenCalledWith(key);
				expect(objects.has(key)).toBe(false);
			}
		},
	);

	it("defers back to the post-mux queue when the manifest is missing", async () => {
		mocks.getObject.mockImplementation(() => pipeValue(Option.none()));

		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const result = await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
			earlyFromSegments: true,
		});

		expect(result.success).toBe(true);
		expect(result.message).toContain("deferred");
		expect(mocks.transcribe).not.toHaveBeenCalled();
		// the claim is released (PROCESSING -> null), never marked ERROR
		expect(mocks.updates).toContainEqual({ transcriptionStatus: null });
		expect(mocks.updates).not.toContainEqual({ transcriptionStatus: "ERROR" });
		expect(mocks.updates).not.toContainEqual({
			transcriptionStatus: "COMPLETE",
		});
		// and the video is re-offered to the normal (non-early) path, because
		// the post-mux queue may already have run and been rejected by the claim
		expect(mocks.startWorkflow).toHaveBeenCalledTimes(1);
		expect(mocks.startWorkflow.mock.calls[0]?.[1]).toEqual([
			{ videoId: "video-123", userId: "user-456", aiGenerationEnabled: false },
		]);
	});

	it("defers when the manifest exists but is not complete", async () => {
		mocks.getObject.mockImplementation(() =>
			pipeValue(
				Option.some(JSON.stringify({ ...manifest, is_complete: false })),
			),
		);

		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const result = await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
			earlyFromSegments: true,
		});

		expect(result.message).toContain("deferred");
		expect(mocks.transcribe).not.toHaveBeenCalled();
		expect(mocks.updates).toContainEqual({ transcriptionStatus: null });
	});

	it("marks NO_AUDIO when the completed manifest has no audio track", async () => {
		mocks.getObject.mockImplementation(() =>
			pipeValue(
				Option.some(
					JSON.stringify({
						...manifest,
						audio_init_uploaded: false,
						audio_segments: [],
					}),
				),
			),
		);

		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const result = await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
			earlyFromSegments: true,
		});

		expect(result.success).toBe(true);
		expect(mocks.transcribe).not.toHaveBeenCalled();
		expect(mocks.updates).toContainEqual({ transcriptionStatus: "NO_AUDIO" });
		expect(mocks.updates).not.toContainEqual({ transcriptionStatus: "ERROR" });
	});

	it("falls back to segment audio in the normal path when no muxed source exists", async () => {
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");

		const result = await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		});

		expect(result.success).toBe(true);
		expect(mocks.transcribe).toHaveBeenCalledTimes(1);
		const writtenKeys = mocks.putObject.mock.calls.map((call) => call[0]);
		expect(writtenKeys).toContain("user-456/video-123/transcription.vtt");
		expect(mocks.updates).toContainEqual({ transcriptionStatus: "COMPLETE" });
		expect(mocks.updates).not.toContainEqual({ transcriptionStatus: "ERROR" });
	});
});

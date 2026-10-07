import { selectRecordingPipeline } from "@cap/recorder-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	defaultSettings,
	loadAuth,
	loadFailedRecordings,
	loadSettings,
} from "../shared/storage";
import type { OffscreenRequest, OffscreenResponse } from "../shared/types";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	delete: vi.fn().mockResolvedValue(undefined),
	initiate: vi.fn(),
	spool: vi.fn(),
	append: vi.fn().mockResolvedValue(undefined),
	dispose: vi.fn().mockResolvedValue(undefined),
	chunk: vi.fn(),
	cancel: vi.fn().mockResolvedValue(undefined),
	manifest: vi.fn().mockResolvedValue(undefined),
	recover: vi.fn(),
}));

vi.mock("../shared/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../shared/api")>()),
	createInstantRecording: mocks.create,
	deleteInstantRecording: mocks.delete,
	updateUploadProgress: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../shared/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("../shared/storage")>()),
	loadFailedRecordings: vi.fn().mockResolvedValue([]),
	loadSettings: vi.fn(),
	loadAuth: vi.fn(),
	loadLiveRecordingManifests: vi.fn().mockResolvedValue([]),
	saveLiveRecordingManifest: mocks.manifest,
	removeLiveRecordingManifest: vi.fn().mockResolvedValue(undefined),
	pruneLiveRecordingManifests: vi.fn().mockResolvedValue(undefined),
	saveFailedRecordings: vi.fn().mockResolvedValue({ dropped: [] }),
}));
vi.mock("@cap/recorder-core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/recorder-core")>()),
	initiateMultipartUpload: mocks.initiate,
	RecordingSpool: { create: mocks.spool },
	listRecordingSpoolSessions: vi.fn().mockResolvedValue([]),
	recoverRecordingSpoolSession: mocks.recover,
	InstantRecordingUploader: class {
		handleChunk = mocks.chunk;
		cancel = mocks.cancel;
	},
}));

let failure: "constructor" | "start" | "all" | "cancel" | null;
const attempts: FakeRecorder[] = [];
class FakeRecorder extends EventTarget {
	static isTypeSupported = (mime: string) =>
		mime.startsWith("video/mp4") || mime.startsWith("video/webm");
	state = "inactive";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	onerror: (() => void) | null = null;
	starts: (number | undefined)[] = [];
	constructor(
		readonly stream: MediaStream,
		readonly options: MediaRecorderOptions,
	) {
		super();
		attempts.push(this);
		if (failure === "constructor" && options.mimeType?.includes("mp4")) {
			throw new TypeError("MP4 construction failed");
		}
	}
	start(timeslice?: number) {
		this.starts.push(timeslice);
		if (failure === "cancel") throw new DOMException("Canceled", "AbortError");
		if (
			failure === "all" ||
			(failure === "start" && this.options.mimeType?.includes("mp4"))
		) {
			throw new Error("Recorder start failed");
		}
		this.state = "recording";
	}
	requestData() {}
}

let listener: (
	message: OffscreenRequest,
	sender: unknown,
	respond: (response: OffscreenResponse) => void,
) => boolean;
const sendMessage = vi.fn();
const track = {
	getSettings: () => ({ width: 1920, height: 1080, frameRate: 30 }),
	addEventListener: vi.fn(),
	stop: vi.fn(),
};
class FakeStream {
	getVideoTracks = () => [track];
	getAudioTracks = () => [];
	getTracks = () => [track];
}
const request = (message: OffscreenRequest) =>
	new Promise<OffscreenResponse>((resolve) => listener(message, {}, resolve));
const start = (apiBaseUrl = "https://cap.example.com") =>
	request({
		target: "offscreen",
		type: "start-recording",
		mode: "tab",
		tabStreamId: "capture-id",
		settings: {
			...defaultSettings,
			apiBaseUrl,
			microphone: { enabled: false, deviceId: null },
			countdown: { enabled: false, seconds: 0 },
			sounds: { enabled: false },
		},
		auth: { authApiKey: "test", userId: "user" },
		bootstrap: {
			organization: { id: "org" },
			plan: { isPro: true, maxRecordingSeconds: null },
		} as unknown as import("../shared/types").BootstrapData,
	});

beforeEach(async () => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.useFakeTimers();
	mocks.delete.mockResolvedValue(undefined);
	failure = null;
	attempts.length = 0;
	mocks.create.mockResolvedValue({
		id: "video",
		shareUrl: "https://example.test/s/video",
	});
	mocks.initiate.mockResolvedValue({ uploadId: "upload", provider: "s3" });
	mocks.spool.mockResolvedValue({
		sessionId: "session",
		appendChunk: mocks.append,
		dispose: mocks.dispose,
	});
	vi.stubGlobal("window", globalThis);
	vi.stubGlobal("navigator", {
		userAgent: "Chrome/149.0.0.0",
		mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(new FakeStream()) },
	});
	vi.stubGlobal("MediaStream", FakeStream);
	vi.stubGlobal("MediaRecorder", FakeRecorder);
	vi.stubGlobal("chrome", {
		runtime: {
			onMessage: {
				addListener: (next: typeof listener) => {
					listener = next;
				},
			},
			sendMessage,
		},
	});
	await import("./recorder");
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("extension recorder start", () => {
	it("mic mute silences only the microphone, not tab audio", async () => {
		const audio = () => ({
			enabled: true,
			stop: vi.fn(),
			addEventListener: vi.fn(),
		});
		const tabAudio = audio();
		const micAudio = audio();
		const mixed = audio();
		vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(
			async (c?: MediaStreamConstraints) => {
				const s = new FakeStream();
				const a = c?.video ? tabAudio : micAudio;
				s.getAudioTracks = () => [a as never];
				return s as unknown as MediaStream;
			},
		);
		vi.stubGlobal(
			"AudioContext",
			class {
				destination = {};
				createMediaStreamSource = () => ({ connect: vi.fn() });
				createMediaStreamDestination = () => ({
					stream: { getAudioTracks: () => [mixed] },
				});
				resume = vi.fn().mockResolvedValue(undefined);
				close = vi.fn().mockResolvedValue(undefined);
			},
		);
		class AudioStream extends FakeStream {
			extra: unknown[] = [];
			addTrack = (t: unknown) => this.extra.push(t);
			getAudioTracks = () => this.extra as never[];
		}
		vi.stubGlobal("MediaStream", AudioStream);
		const r = await request({
			target: "offscreen",
			type: "start-recording",
			mode: "tab",
			tabStreamId: "capture-id",
			settings: {
				...defaultSettings,
				apiBaseUrl: "https://cap.example.com",
				microphone: { enabled: true, deviceId: null },
				countdown: { enabled: false, seconds: 0 },
				sounds: { enabled: false },
			},
			auth: { authApiKey: "k", userId: "user" },
			bootstrap: {
				organization: { id: "org" },
				plan: { isPro: true, maxRecordingSeconds: null },
			} as unknown as import("../shared/types").BootstrapData,
		});
		expect(r).toMatchObject({ ok: true });
		const mute = (muted: boolean) =>
			request({
				target: "offscreen",
				type: "toggle-microphone-mute",
				muted,
			} as OffscreenRequest);
		await mute(true);
		expect(micAudio.enabled).toBe(false);
		expect(tabAudio.enabled).toBe(true);
		expect(mixed.enabled).toBe(true);
		await mute(false);
		expect(micAudio.enabled).toBe(true);
	});

	it("rejects recording without a server before capture or upload", async () => {
		expect(await start("")).toMatchObject({
			ok: false,
			error: expect.stringMatching(/server URL not set/i),
		});
		expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.initiate).not.toHaveBeenCalled();
	});

	it("rejects retry without a server even when a share URL was saved", async () => {
		vi.mocked(loadSettings).mockResolvedValue({
			...defaultSettings,
			apiBaseUrl: "",
		});
		vi.mocked(loadAuth).mockResolvedValue({
			authApiKey: "test-token",
			userId: "user",
		});
		vi.mocked(loadFailedRecordings).mockResolvedValue([
			{
				sessionId: "session",
				videoId: "video",
				shareUrl: "https://cap.example.com/s/video",
				mimeType: "video/mp4",
				subpath: "raw-upload.mp4",
				durationMs: 1000,
				width: 1920,
				height: 1080,
				fps: 30,
				totalBytes: 1,
				createdAt: 1,
				message: null,
			},
		]);
		mocks.recover.mockResolvedValue({ blob: new Blob(["recording"]) });
		expect(
			await request({
				target: "offscreen",
				type: "retry-upload",
				videoId: "video",
			}),
		).toMatchObject({
			ok: false,
			error: expect.stringMatching(/server URL not set/i),
		});
		expect(mocks.initiate).not.toHaveBeenCalled();
	});

	it("keeps the real Chrome MP4 selector", () => {
		expect(selectRecordingPipeline(true)).toMatchObject({
			mode: "streaming",
			fileExtension: "mp4",
		});
	});
	it.each(["constructor", "start"] as const)(
		"streams WebM after MP4 %s rejection on the same tracks",
		async (reason) => {
			failure = reason;
			expect(await start()).toMatchObject({
				ok: true,
				status: { phase: "recording" },
			});
			expect(attempts).toHaveLength(2);
			expect(attempts[1]?.stream).toBe(attempts[0]?.stream);
			expect(attempts[1]?.options).toEqual({
				mimeType: "video/webm;codecs=vp9",
			});
			if (reason === "start") {
				expect(attempts[0]?.starts).toEqual([1000, undefined]);
				expect(mocks.cancel).toHaveBeenCalledOnce();
				expect(mocks.delete).toHaveBeenCalledOnce();
			} else {
				expect(mocks.create).toHaveBeenCalledOnce();
				expect(mocks.initiate).toHaveBeenCalledOnce();
			}
			expect(mocks.initiate).toHaveBeenLastCalledWith(
				expect.objectContaining({
					contentType: "video/webm;codecs=vp9",
					subpath: "raw-upload.webm",
				}),
			);
			expect(mocks.create).toHaveBeenLastCalledWith(
				expect.objectContaining({
					input: expect.objectContaining({ videoCodec: "vp9" }),
				}),
			);
			expect(mocks.spool).toHaveBeenLastCalledWith({
				mimeType: "video/webm;codecs=vp9",
			});
			expect(mocks.manifest).toHaveBeenLastCalledWith(
				expect.objectContaining({
					subpath: "raw-upload.webm",
					mimeType: "video/webm;codecs=vp9",
				}),
			);
			const chunk = new Blob(["webm bytes"]);
			attempts[1]?.ondataavailable?.({ data: chunk });
			await Promise.resolve();
			expect(mocks.chunk).toHaveBeenCalledWith(chunk, chunk.size);
			expect(mocks.append).toHaveBeenCalledWith(chunk);
			expect(track.stop).not.toHaveBeenCalled();
		},
	);
	it("reports and broadcasts error after all start attempts fail, including status sync", async () => {
		failure = "all";
		mocks.delete.mockImplementation(async () => {
			const response = await request({
				target: "offscreen",
				type: "get-recording-status",
			});
			if (!response.ok) throw new Error(response.error);
			expect(response.status?.phase).not.toBe("recording");
		});
		expect(await start()).toMatchObject({ ok: false });
		expect(
			await request({ target: "offscreen", type: "get-recording-status" }),
		).toMatchObject({ status: { phase: "error" } });
		expect(sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: { phase: "error", message: "Recorder start failed" },
			}),
			expect.any(Function),
		);
		expect(attempts).toHaveLength(2);
	});
	it("rejects a duplicate start without destroying the active recording", async () => {
		expect(await start()).toMatchObject({
			ok: true,
			status: { phase: "recording" },
		});
		expect(await start()).toMatchObject({
			ok: false,
			error: "Recording is already active",
		});
		expect(
			await request({ target: "offscreen", type: "get-recording-status" }),
		).toMatchObject({ status: { phase: "recording" } });
		expect(mocks.delete).not.toHaveBeenCalled();
		expect(track.stop).not.toHaveBeenCalled();
	});
	it("reports and broadcasts idle for cancellation", async () => {
		failure = "cancel";
		expect(await start()).toMatchObject({ ok: false, canceled: true });
		expect(
			await request({ target: "offscreen", type: "get-recording-status" }),
		).toMatchObject({ status: { phase: "idle" } });
		expect(sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ status: { phase: "idle" } }),
			expect.any(Function),
		);
	});
});

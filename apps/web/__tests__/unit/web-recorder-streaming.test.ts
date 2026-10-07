import { Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebRecorder } from "../../app/(org)/dashboard/caps/components/web-recorder-dialog/useWebRecorder";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	delete: vi.fn().mockResolvedValue(undefined),
	initiate: vi.fn(),
	spool: vi.fn(),
	append: vi.fn().mockResolvedValue(undefined),
	dispose: vi.fn().mockResolvedValue(undefined),
	chunk: vi.fn(),
	cancel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("react", () => ({
	useRef: (current: unknown) => ({ current }),
	useState: (initial: unknown) => [
		typeof initial === "function" ? initial() : initial,
		vi.fn(),
	],
	useCallback: (callback: unknown) => callback,
	useEffect: vi.fn(),
}));
vi.mock("@cap/web-domain", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/web-domain")>()),
	Organisation: { OrganisationId: { make: (id: string) => id } },
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/actions/video/trigger-instant-recording-processing", () => ({
	triggerInstantRecordingProcessing: vi.fn(),
}));
vi.mock("@/actions/video/upload", () => ({
	createVideoAndGetUploadUrl: vi.fn(),
}));
vi.mock("@/lib/Requests/ThumbnailRequest", () => ({ ThumbnailRequest: {} }));
vi.mock("@/utils/upload-target", () => ({ uploadWithTarget: vi.fn() }));
vi.mock("@/lib/EffectRuntime", () => ({
	useRpcClient: () => ({
		VideoDelete: mocks.delete,
		VideoInstantCreate: mocks.create,
	}),
	useEffectMutation: ({
		mutationFn,
	}: {
		mutationFn: (input: unknown) => unknown;
	}) => ({ mutateAsync: mutationFn }),
}));
vi.mock("../../app/(org)/dashboard/caps/UploadingContext", () => ({
	useUploadingContext: () => ({ setUploadStatus: vi.fn() }),
}));
vi.mock("../../app/(org)/dashboard/caps/components/sendProgressUpdate", () => ({
	sendProgressUpdate: vi.fn(),
}));
vi.mock(
	"../../app/(org)/dashboard/caps/components/web-recorder-dialog/recording-conversion",
	() => ({
		canConvertToMp4InBrowser: vi.fn(),
		captureThumbnail: vi.fn(),
		convertToMp4: vi.fn(),
	}),
);
vi.mock(
	"../../app/(org)/dashboard/caps/components/web-recorder-dialog/recording-upload",
	() => ({ uploadRecording: vi.fn() }),
);
vi.mock(
	"../../app/(org)/dashboard/caps/components/web-recorder-dialog/recovered-recording-cache",
	() => ({
		loadRecoveredRecordingSpools: vi.fn(),
		removeRecoveredRecordingSpoolFromCache: vi.fn(),
	}),
);
vi.mock(
	"../../app/(org)/dashboard/caps/components/web-recorder-dialog/useRecordingTimer",
	() => ({
		useRecordingTimer: () => ({
			durationMs: 0,
			startTimer: vi.fn(),
			resetTimer: vi.fn(),
			clearTimer: vi.fn(),
		}),
	}),
);
vi.mock(
	"../../app/(org)/dashboard/caps/components/web-recorder-dialog/useSurfaceDetection",
	() => ({
		useSurfaceDetection: () => ({ scheduleSurfaceDetection: vi.fn() }),
	}),
);
vi.mock("@cap/recorder-core/instant-mp4-uploader", () => ({
	initiateMultipartUpload: mocks.initiate,
	MultipartCompletionUncertainError: class extends Error {},
	InstantRecordingUploader: class {
		handleChunk = mocks.chunk;
		cancel = mocks.cancel;
	},
}));
vi.mock("@cap/recorder-core/recording-spool", () => ({
	canUseRecordingSpool: () => true,
	RecordingSpool: { create: mocks.spool },
	RECORDING_SPOOL_HEARTBEAT_INTERVAL_MS: 10000,
	deleteRecoveredRecordingSpool: vi.fn(),
}));

let failure: "constructor" | "start" | "timeslice" | null;
const attempts: FakeRecorder[] = [];
class FakeRecorder extends EventTarget {
	static isTypeSupported = (mime: string) =>
		mime.startsWith("video/mp4") || mime.startsWith("video/webm");
	state = "inactive";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	starts: (number | undefined)[] = [];
	constructor(
		readonly stream: MediaStream,
		readonly options: MediaRecorderOptions,
	) {
		super();
		attempts.push(this);
		if (failure === "constructor" && options.mimeType?.includes("mp4"))
			throw new TypeError("MP4 construction failed");
	}
	start(timeslice?: number) {
		this.starts.push(timeslice);
		if (
			(failure === "start" && this.options.mimeType?.includes("mp4")) ||
			(failure === "timeslice" && timeslice)
		)
			throw new Error("Recorder start failed");
		this.state = "recording";
	}
	requestData() {}
}
const track = {
	getSettings: () => ({ width: 1920, height: 1080 }),
	addEventListener: vi.fn(),
	stop: vi.fn(),
};
class FakeStream {
	getVideoTracks = () => [track];
	getAudioTracks = () => [];
	getTracks = () => [track];
}
beforeEach(() => {
	vi.useFakeTimers();
	mocks.append.mockResolvedValue(undefined);
	mocks.dispose.mockResolvedValue(undefined);
	mocks.cancel.mockResolvedValue(undefined);
	mocks.delete.mockResolvedValue(undefined);
	failure = null;
	attempts.length = 0;
	mocks.create.mockResolvedValue(
		Exit.succeed({ id: "video", shareUrl: "https://example.test/s/video" }),
	);
	mocks.initiate.mockResolvedValue({ uploadId: "upload", provider: "s3" });
	mocks.spool.mockResolvedValue({
		sessionId: "session",
		appendChunk: mocks.append,
		dispose: mocks.dispose,
	});
	vi.stubGlobal("window", globalThis);
	vi.stubGlobal("MediaRecorder", FakeRecorder);
	vi.stubGlobal("MediaStream", FakeStream);
	vi.stubGlobal("navigator", {
		userAgent: "Chrome/149.0.0.0",
		mediaDevices: {
			getUserMedia: vi.fn().mockResolvedValue(new FakeStream()),
			getDisplayMedia: vi.fn().mockResolvedValue(new FakeStream()),
		},
	});
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
const recorder = (onPhaseChange = vi.fn()) =>
	useWebRecorder({
		organisationId: "org",
		selectedMicId: null,
		micEnabled: false,
		systemAudioEnabled: false,
		recordingMode: "camera",
		selectedCameraId: "camera",
		isProUser: true,
		onPhaseChange,
	});

describe("web recorder start", () => {
	it.each(["constructor", "start"] as const)(
		"streams WebM after MP4 %s rejection on the same tracks",
		async (reason) => {
			failure = reason;
			const phase = vi.fn();
			await recorder(phase).startRecording();
			expect(phase).toHaveBeenLastCalledWith("recording");
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
				expect.objectContaining({ videoCodec: "vp9", audioCodec: undefined }),
			);
			expect(mocks.spool).toHaveBeenLastCalledWith({
				mimeType: "video/webm;codecs=vp9",
			});
			const chunk = new Blob(["webm bytes"]);
			attempts[1]?.ondataavailable?.({ data: chunk });
			expect(mocks.chunk).toHaveBeenCalledWith(chunk, chunk.size);
			expect(mocks.append).toHaveBeenCalledWith(chunk);
			expect(track.stop).not.toHaveBeenCalled();
		},
	);
	it("retains MP4 and manual chunking when only timeslice start fails", async () => {
		failure = "timeslice";
		const phase = vi.fn();
		await recorder(phase).startRecording();
		expect(phase).toHaveBeenLastCalledWith("recording");
		expect(attempts).toHaveLength(1);
		expect(attempts[0]?.starts).toEqual([1000, undefined]);
		expect(attempts[0]?.options).toEqual({
			mimeType: "video/mp4;codecs=avc1",
			videoKeyFrameIntervalDuration: 1000,
		});
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
});

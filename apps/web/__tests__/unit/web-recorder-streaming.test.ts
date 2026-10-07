import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	new URL(
		"../../app/(org)/dashboard/caps/components/web-recorder-dialog/useWebRecorder.ts",
		import.meta.url,
	),
	"utf8",
);

const commentSource = readFileSync(
	new URL(
		"../../app/s/[videoId]/_components/timeline/recording/useCommentRecorder.ts",
		import.meta.url,
	),
	"utf8",
);

describe("web recorder streaming wiring", () => {
	it("routes both containers through the existing streaming lifecycle", () => {
		expect(source).not.toContain("streaming-webm");
		expect(source).toContain('pipeline.mode === "streaming"');
		expect(/raw-upload\.\$\{pipeline\.fileExtension\}/.test(source)).toBe(true);
		expect(source).toContain(
			"recorder.start(INSTANT_UPLOAD_REQUEST_INTERVAL_MS)",
		);
	});

	it("sets the 1 s keyframe interval only for MP4", () => {
		expect(source).toMatch(
			/pipeline\.fileExtension === "mp4"\s*\? \{ videoKeyFrameIntervalDuration: 1000 \}\s*:\s*\{\}/,
		);
	});

	it("uses negotiated video/audio codecs for the video row", () => {
		expect(source).toContain("describeRecordingCodecs(");
		expect(source).not.toContain('audioCodec: hasAudio ? "aac" : undefined');
		expect(source).not.toContain(
			'audioCodec: hasAudioTrack ? "aac" : undefined',
		);
	});

	it("keeps comments on the buffered selector", () => {
		expect(commentSource).toContain("{ preferStreamingUpload: false }");
	});
});

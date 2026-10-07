import { readFileSync } from "node:fs";
import { selectRecordingPipeline } from "@cap/recorder-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("./recorder.ts", import.meta.url), "utf8");

afterEach(() => vi.unstubAllGlobals());

describe("extension recorder streaming wiring", () => {
	it("uses the shared Chrome MP4 pipeline", () => {
		vi.stubGlobal("navigator", { userAgent: "Chrome/149.0.0.0" });
		vi.stubGlobal("MediaRecorder", {
			isTypeSupported: (mime: string) =>
				mime === "video/mp4;codecs=avc1,opus" || mime.startsWith("video/webm"),
		});
		expect(selectRecordingPipeline(true)).toMatchObject({
			mode: "streaming",
			mimeType: "video/mp4;codecs=avc1,opus",
			fileExtension: "mp4",
		});
		expect(source).toContain(
			"const pipeline = selectRecordingPipeline(hasAudio)",
		);
	});

	it("sets the 1 s keyframe interval only for MP4", () => {
		expect(source).toMatch(
			/pipeline\.fileExtension === "mp4"\s*\? \{ videoKeyFrameIntervalDuration: 1000 \}\s*:\s*\{\}/,
		);
	});

	it("caps tab capture at 1080p and 30 fps", () => {
		expect(source).toContain("maxWidth: DEFAULT_WIDTH");
		expect(source).toContain("maxHeight: DEFAULT_HEIGHT");
		expect(source).toContain("maxFrameRate: DEFAULT_FPS");
	});

	it("keeps camera capture capped through device retries", () => {
		expect(source).toContain("...cameraVideoConstraints()");
		expect(source).not.toContain("video: true,");
	});
});

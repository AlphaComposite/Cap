import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	buildStreamCopySegmentArgs,
	buildTranscodeEditArgs,
	buildTranscodeSegmentArgs,
	normalizeEditRanges,
	renderEditedVideo,
} from "../../lib/media-edit";
import { probeVideo } from "../../lib/media-probe";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO = join(FIXTURES_DIR, "test-with-audio.mp4");
const TEST_VIDEO_NO_AUDIO = join(FIXTURES_DIR, "test-no-audio.mp4");

const tempFiles: string[] = [];

function readH264Encoding(filePath: string) {
	const result = JSON.parse(
		execFileSync("ffprobe", [
			"-hide_banner",
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=level,time_base",
			"-of",
			"json",
			filePath,
		]).toString(),
	) as {
		streams?: Array<{ level: number; time_base: string }>;
	};
	const stream = result.streams?.[0];
	if (!stream) {
		throw new Error("Edited video has no H.264 stream");
	}
	return { level: stream.level, timeBase: stream.time_base };
}

function readStreamEndpointDifference(filePath: string) {
	const result = JSON.parse(
		execFileSync("ffprobe", [
			"-hide_banner",
			"-v",
			"error",
			"-show_entries",
			"stream=codec_type,start_time,duration",
			"-of",
			"json",
			filePath,
		]).toString(),
	) as {
		streams?: Array<{
			codec_type: "audio" | "video";
			start_time: string;
			duration: string;
		}>;
	};
	const video = result.streams?.find((stream) => stream.codec_type === "video");
	const audio = result.streams?.find((stream) => stream.codec_type === "audio");
	if (!video || !audio)
		throw new Error("Edited video must contain A/V streams");
	const videoEnd = Number(video.start_time) + Number(video.duration);
	const audioEnd = Number(audio.start_time) + Number(audio.duration);
	return Math.abs(videoEnd - audioEnd);
}

afterAll(() => {
	for (const file of tempFiles) {
		if (existsSync(file)) {
			rmSync(file);
		}
	}
});

describe("media edit helpers", () => {
	test("normalizes edit ranges", () => {
		expect(
			normalizeEditRanges(
				[
					{ start: 3, end: 5 },
					{ start: -1, end: 0.01 },
					{ start: 8, end: 12 },
				],
				10,
			),
		).toEqual([
			{ start: 3, end: 5 },
			{ start: 8, end: 10 },
		]);
	});

	test("merges ranges separated by tiny gaps", () => {
		expect(
			normalizeEditRanges(
				[
					{ start: 0, end: 1 },
					{ start: 1.02, end: 2 },
					{ start: 3, end: 3.02 },
				],
				5,
			),
		).toEqual([{ start: 0, end: 2 }]);
	});

	test("builds stream-copy segment args", () => {
		const args = buildStreamCopySegmentArgs(
			"/input.mp4",
			{
				start: 1,
				end: 3.25,
			},
			"/segment.mp4",
		);

		expect(args).toContain("copy");
		expect(args).toContain("-avoid_negative_ts");
		expect(args).toContain("2.250");
	});

	test("builds no-audio transcode args", () => {
		const args = buildTranscodeSegmentArgs(
			"/input.mp4",
			{ start: 0, end: 1 },
			"/segment.mp4",
			false,
		);

		expect(args).toContain("libx264");
		expect(args).toContain(
			"[0:v:0]fps=30,trim=start=0.000:end=1.000,setpts=PTS-STARTPTS[v]",
		);
		expect(args).toContain("-an");
		expect(args).not.toContain("0:a:0?");
	});

	test("builds audio transcode args", () => {
		const args = buildTranscodeSegmentArgs(
			"/input.mp4",
			{ start: 0, end: 1 },
			"/segment.mp4",
			true,
		);

		expect(args).toContain("aac");
		expect(args).toContain(
			"[0:v:0]fps=30,trim=start=0.000:end=1.000,setpts=PTS-STARTPTS[v];[0:a:0]atrim=start=0.000:end=1.000,asetpts=PTS-STARTPTS[a]",
		);
		expect(args).toContain("[a]");
	});

	test("builds a bounded multi-input transcode graph", () => {
		const args = buildTranscodeEditArgs(
			"/input.mp4",
			[
				{ start: 0, end: 1 },
				{ start: 1.2, end: 2 },
				{ start: 2.3, end: 3 },
			],
			"/output.mp4",
			true,
			60,
		);
		const filter = args[args.indexOf("-filter_complex") + 1];

		expect(args.filter((value) => value === "-i")).toHaveLength(3);
		expect(args.filter((value) => value === "-ss")).toHaveLength(3);
		expect(filter).toContain("concat=n=3:v=1:a=1[v][a]");
		expect(filter).toContain("[1:v:0]fps=60,setpts=PTS-STARTPTS[v1]");
		expect(filter).toContain(
			"[0:a:0]asetpts=PTS-STARTPTS,afade=t=out:st=0.985:d=0.015[a0]",
		);
		expect(filter).toContain(
			"[1:a:0]asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.015,afade=t=out:st=0.785:d=0.015[a1]",
		);
		expect(filter).toContain(
			"[2:a:0]asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.015[a2]",
		);
		expect(args[args.indexOf("-enc_time_base:v") + 1]).toBe("1/60");
	});

	test("keeps 30ms splice fades across transcode batch boundaries", () => {
		const args = buildTranscodeEditArgs(
			"/input.mp4",
			[{ start: 4, end: 5 }],
			"/output.mp4",
			true,
			30,
			{ rangeOffset: 4, totalRangeCount: 6 },
		);
		const filter = args[args.indexOf("-filter_complex") + 1];

		expect(filter).toContain("afade=t=in:st=0:d=0.015");
		expect(filter).toContain("afade=t=out:st=0.985:d=0.015");
	});

	test("pins fractional frame rates to a safe encoder time base", () => {
		const args = buildTranscodeEditArgs(
			"/input.mp4",
			[{ start: 0, end: 1 }],
			"/output.mp4",
			true,
			29.97,
		);

		expect(args[args.indexOf("-enc_time_base:v") + 1]).toBe("1/29.97");
	});

	test("rejects unbounded transcode graphs", () => {
		expect(() =>
			buildTranscodeEditArgs(
				"/input.mp4",
				Array.from({ length: 5 }, (_, index) => ({
					start: index,
					end: index + 0.5,
				})),
				"/output.mp4",
				true,
			),
		).toThrow("Transcode batches must contain 1-4 ranges");
	});
});

describe("renderEditedVideo integration tests", () => {
	test("renders an edited mp4 with audio using the real ffmpeg path", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);
		const progressUpdates: number[] = [];

		const editedFile = await renderEditedVideo({
			inputPath: TEST_VIDEO_WITH_AUDIO,
			keepRanges: [
				{ start: 0.08, end: 0.16 },
				{ start: 0.24, end: 0.32 },
				{ start: 0.4, end: 0.48 },
				{ start: 0.56, end: 0.64 },
				{ start: 0.72, end: 0.8 },
			],
			metadata,
			onProgress: (progress) => {
				progressUpdates.push(progress);
			},
		});
		tempFiles.push(editedFile.path);

		const outputMetadata = await probeVideo(`file://${editedFile.path}`);
		expect(outputMetadata.videoCodec).toBe("h264");
		expect(outputMetadata.audioCodec).toBe("aac");
		expect(outputMetadata.duration).toBeGreaterThan(0.3);
		expect(outputMetadata.duration).toBeLessThan(metadata.duration + 0.2);
		expect(readStreamEndpointDifference(editedFile.path)).toBeLessThanOrEqual(
			0.02,
		);
		expect(progressUpdates.length).toBeGreaterThan(0);
		expect(progressUpdates.at(-1)).toBe(75);
		const encoding = readH264Encoding(editedFile.path);
		expect(encoding.level).toBeLessThanOrEqual(42);
		expect(encoding.timeBase).not.toBe("1/1000000");

		await editedFile.cleanup();
	}, 60000);

	test("renders an edited mp4 without adding an audio track", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_NO_AUDIO}`);

		const editedFile = await renderEditedVideo({
			inputPath: TEST_VIDEO_NO_AUDIO,
			keepRanges: [{ start: 0, end: 0.6 }],
			metadata,
		});
		tempFiles.push(editedFile.path);

		const outputMetadata = await probeVideo(`file://${editedFile.path}`);
		expect(outputMetadata.videoCodec).toBe("h264");
		expect(outputMetadata.audioCodec).toBeNull();
		expect(outputMetadata.duration).toBeGreaterThan(0.2);
		expect(outputMetadata.duration).toBeLessThan(metadata.duration + 0.2);
		const encoding = readH264Encoding(editedFile.path);
		expect(encoding.level).toBeLessThanOrEqual(42);
		expect(encoding.timeBase).not.toBe("1/1000000");

		await editedFile.cleanup();
	}, 60000);
});

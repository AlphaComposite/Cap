import { describe, expect, test } from "bun:test";
import { transcodeThreads } from "../../lib/media-video";

describe("transcodeThreads", () => {
	test("defaults to 2 and accepts a sane override", () => {
		expect(transcodeThreads({})).toBe("2");
		expect(transcodeThreads({ MEDIA_TRANSCODE_THREADS: "6" })).toBe("6");
		for (const bad of ["0", "-1", "abc", "99", ""]) {
			expect(transcodeThreads({ MEDIA_TRANSCODE_THREADS: bad })).toBe("2");
		}
	});
});

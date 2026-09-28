import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
	EDIT_TRANSCRIPT_VERSION,
	type EditTranscript,
} from "@/lib/edit-transcript";
import { deriveRevisionCaptions } from "@/lib/revision-publication-metadata";
import { createIdentityEditSpec } from "@/lib/video-edits";

// cap-fzp.8.7.37: revision captions must group words into caption lines the
// same way the upload path does (formatToWebVTT), not one cue per word.
function word(id: string, text: string, startMs: number, endMs: number) {
	return {
		id,
		text,
		startMs,
		endMs,
		confidence: 1,
		speaker: null,
		channel: null,
	};
}

describe("revision captions grouping", () => {
	it("groups words into sentence cues and keeps the duration note", () => {
		const spec = createIdentityEditSpec(10) as never;
		const transcript: EditTranscript = {
			version: EDIT_TRANSCRIPT_VERSION,
			speechModelUsed: "test",
			durationMs: 10_000,
			languageCode: "en",
			words: [
				word("a", "Hello", 100, 400),
				word("b", "there", 450, 700),
				word("c", "friend.", 750, 1100),
				word("d", "Next", 1200, 1400),
				word("e", "line", 1450, 1700),
			],
		};
		const { vtt, wordCount } = deriveRevisionCaptions({
			transcript,
			nextSpec: spec,
		});
		expect(wordCount).toBe(5);
		expect(vtt).toContain("NOTE duration_seconds=10.000");
		expect(vtt).toContain("Hello there friend.");
		expect(vtt).toContain("Next line");
		expect(vtt.match(/-->/g)?.length).toBe(2);
	});
});

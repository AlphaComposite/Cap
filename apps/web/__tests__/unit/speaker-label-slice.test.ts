import { describe, expect, it } from "vitest";
import { parseVTT } from "@/app/s/[videoId]/_components/utils/transcript-utils";
import {
	createEditTranscript,
	editTranscriptWordsToCaptionVtt,
	parseEditTranscript,
	remapEditTranscriptThroughSpec,
	serializeEditTranscript,
} from "@/lib/edit-transcript";
import { deriveRevisionCaptions } from "@/lib/revision-publication-metadata";
import { formatToWebVTT } from "@/lib/transcribe-utils";
import { updateVttEntryText } from "@/lib/transcript-vtt";
import {
	createTimelineStateFromEditSpec,
	getTimelineEditSpec,
} from "@/lib/video-edits";

const words = [
	{ text: "First", start: 0, end: 500, speaker: "A" },
	{ text: "removed", start: 1000, end: 1500, speaker: "B" },
	{ text: "Again", start: 2000, end: 2500, speaker: "A" },
	{ text: "Second", start: 3000, end: 3500, speaker: "B" },
	{ text: "Unknown", start: 3600, end: 3900 },
];
const spec = getTimelineEditSpec(
	createTimelineStateFromEditSpec({
		version: 1,
		sourceDuration: 4,
		keepRanges: [
			{ start: 0, end: 0.8 },
			{ start: 1.8, end: 4 },
		],
	}),
);

describe("offline speaker label slice", () => {
	it("does not invent a second speaker when only one or no labels are returned", () => {
		const single = formatToWebVTT({
			words: words.map((word) => ({ ...word, speaker: "A" })),
		});
		expect(single).toContain("cap-speaker-A");
		expect(single).not.toContain("cap-speaker-B");
		const missing = formatToWebVTT({
			words: words.map(({ speaker: _speaker, ...word }) => word),
		});
		expect(missing).not.toContain("cap-speaker-");
	});

	it("splits at every speaker transition, including unknown speech", () => {
		const vtt = formatToWebVTT({ words });
		expect(vtt.match(/-->/g)).toHaveLength(5);
		expect(vtt).toContain("<v cap-speaker-A>First</v>");
		expect(vtt).toContain("<v cap-speaker-B>Second</v>");
		expect(vtt).toContain("\nUnknown\n");
	});

	it("keeps immutable attribution and edited clocks through storage, cut and revision projection", () => {
		const original = createEditTranscript({ words }, 4000);
		const stored = parseEditTranscript(serializeEditTranscript(original));
		expect(stored).not.toBeNull();
		if (!stored) throw new Error("missing transcript");
		const edited = remapEditTranscriptThroughSpec(stored, spec);
		expect(edited.words.map((word) => [word.id, word.speaker])).toEqual(
			original.words
				.filter((word) => word.text !== "removed")
				.map((word) => [word.id, word.speaker]),
		);
		expect(edited.words[2]?.startMs).toBe(2000);
		const projected = deriveRevisionCaptions({
			transcript: stored,
			nextSpec: spec,
		});
		expect(projected.wordCount).toBe(4);
		expect(projected.vtt).not.toContain("removed");
		expect(projected.vtt).toContain("<v cap-speaker-B>Second</v>");
		expect(projected.vtt).toContain("00:00:02.000 --> 00:00:02.500");
		expect(editTranscriptWordsToCaptionVtt(edited.words)).toContain(
			"<v cap-speaker-A>First Again</v>",
		);
		expect(parseVTT(projected.vtt).map((cue) => cue.text)).toEqual([
			"First Again",
			"Second",
			"Unknown",
		]);
	});

	it("rejects invalid attribution but keeps usable text", () => {
		const transcript = createEditTranscript(
			{
				words: [
					{ text: "safe", start: 0, end: 500, speaker: "A><v evil" },
					{ text: "also", start: 500, end: 900, speaker: "X".repeat(33) },
				],
			},
			1000,
		);
		expect(transcript.words.map((word) => word.speaker)).toEqual([null, null]);
		expect(editTranscriptWordsToCaptionVtt(transcript.words)).not.toContain(
			"<v",
		);
	});

	it("preserves original attribution on text edit and cannot manufacture it", () => {
		const labeled =
			"WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n<v cap-speaker-A>Hello</v>\n\n";
		const result = updateVttEntryText(
			labeled,
			1,
			"<v cap-speaker-B>literal</v> &amp;",
		);
		expect(result.content).toContain(
			"<v cap-speaker-A>&lt;v cap-speaker-B&gt;literal&lt;/v&gt; &amp;amp;</v>",
		);
		const legacy = labeled.replace("<v cap-speaker-A>Hello</v>", "Hello");
		expect(
			updateVttEntryText(legacy, 1, "<v cap-speaker-B>literal</v>").content,
		).toContain("<c.cap-text>&lt;v cap-speaker-B&gt;literal&lt;/v&gt;</c>");
	});

	it("leaves unaffected legacy output byte identical", () => {
		expect(
			formatToWebVTT({
				words: [{ text: "Hello &amp; ordinary", start: 0, end: 1000 }],
			}),
		).toBe(
			"WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nHello &amp; ordinary\n\n",
		);
	});
});

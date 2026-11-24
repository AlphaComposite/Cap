import { describe, expect, it } from "vitest";
import { getActiveCaptionText } from "@/app/s/[videoId]/_components/caption-cues";
import {
	formatTranscriptAsVTT,
	parseVTT,
} from "@/app/s/[videoId]/_components/utils/transcript-utils";
import { parseAgentVtt } from "@/lib/agent-api";
import { formatTranscriptAsParagraphs } from "@/lib/transcript-text";
import {
	formatTranscriptCuePayload,
	parseTranscriptCuePayload,
	projectTranscriptCueText,
	stripTranscriptVoiceAnnotations,
} from "@/lib/transcript-vtt";

const asVtt = (payload: string) =>
	`WEBVTT\n\n1\n00:00:01.250 --> 00:00:02.500\n${payload}\n\n`;
function caption(payload: string) {
	return getActiveCaptionText({
		length: 1,
		item: () => ({ text: payload, startTime: 1.25 }),
	} as unknown as TextTrackCueList);
}

describe("speaker text projections", () => {
	it.each([
		"<v cap-speaker-B>not attribution</v> & ordinary text",
		"&lt;v cap-speaker-B&gt;not attribution&lt;/v&gt; &amp;",
		"<b>literal formatting</b> &nbsp;",
	])("decodes only the original marked layer: %s", (literal) => {
		const payload = formatTranscriptCuePayload(literal, "A");
		expect(parseTranscriptCuePayload(payload)).toEqual({
			text: literal,
			speaker: "A",
		});
		expect(caption(payload)).toBe(literal);
		expect(parseAgentVtt(asVtt(payload))).toEqual([
			{ startMs: 1250, endMs: 2500, text: literal },
		]);
		expect(parseVTT(asVtt(payload)).map((cue) => cue.text)).toEqual([literal]);
		expect(projectTranscriptCueText(payload)).toBe(literal);
		expect(
			formatTranscriptAsParagraphs([
				{
					text: projectTranscriptCueText(payload),
					startTime: 1.25,
					endTime: 2.5,
				},
			]),
		).toBe(literal);
	});

	it.each(["<v cap-speaker-B>literal</v>", "literal &lt; text"])(
		"re-escapes decoded text in an embed track: %s",
		(literal) => {
			const source = asVtt(formatTranscriptCuePayload(literal, "A"));
			const output = formatTranscriptAsVTT(parseVTT(source));
			expect(output.split("\n")[4]).toBe(
				literal
					.replace(/&/g, "&amp;")
					.replace(/</g, "&lt;")
					.replace(/>/g, "&gt;"),
			);
		},
	);

	it("leaves every unmarked entity and native markup behavior unchanged", () => {
		const legacy = "Hello &amp; &lt;v cap-speaker-B&gt;literal&lt;/v&gt;";
		expect(caption(legacy)).toBe(legacy);
		expect(parseAgentVtt(asVtt(legacy))[0]?.text).toBe(legacy);
		expect(projectTranscriptCueText(legacy)).toBe(legacy);
		expect(caption("<v Speaker><b>Hello</b></v>")).toBe("Hello");
	});

	it("never interprets decoded literal text as attribution or trusts malformed carriers", () => {
		const literal = "<v cap-speaker-B>literal</v>";
		expect(
			parseTranscriptCuePayload(formatTranscriptCuePayload(literal)),
		).toEqual({ text: literal, speaker: null });
		for (const invalid of [
			"<v cap-speaker-A><v cap-speaker-B>nested</v></v>",
			"<v cap-speaker-A bad>text</v>",
			`<v cap-speaker-${"A".repeat(33)}>text</v>`,
		]) {
			expect(parseTranscriptCuePayload(invalid)).toBeNull();
		}
	});

	it("removes translation attribution without unescaping literal markup", () => {
		const original = formatTranscriptCuePayload(
			"<v cap-speaker-B>literal</v> &amp;",
			"A",
		);
		const translated = stripTranscriptVoiceAnnotations(asVtt(original));
		expect(translated).not.toContain("<v");
		expect(translated).not.toContain("cap-speaker-A");
		const payload = translated.split("\n")[4] ?? "";
		expect(parseTranscriptCuePayload(payload)).toEqual({
			text: "<v cap-speaker-B>literal</v> &amp;",
			speaker: null,
		});
	});
});

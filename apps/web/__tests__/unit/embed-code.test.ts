import { describe, expect, it } from "vitest";
import { buildEmbedCode } from "@/lib/embed-code";

const defaultCode =
	'<div style="position: relative; padding-bottom: 56.25%; height: 0;"><iframe src="https://cap.so/embed/abc123" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"></iframe></div>';
const input = { webUrl: "https://cap.so", videoId: "abc123" };

describe("embed snippets", () => {
	it.each([undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"preserves the exact default snippet with startTime=%s",
		(startTime) => {
			expect(buildEmbedCode({ ...input, startTime })).toBe(defaultCode);
			expect(
				buildEmbedCode({
					...input,
					startTime,
					options: { showTitle: true, showOwner: true },
				}),
			).toBe(defaultCode);
		},
	);

	it.each([0.5, 83, 83.7])(
		"preserves timestamp %s byte-for-byte",
		(startTime) => {
			expect(buildEmbedCode({ ...input, startTime })).toBe(
				defaultCode.replace("abc123", `abc123?t=${Math.floor(startTime)}`),
			);
		},
	);

	it.each([
		{ options: { showTitle: false }, query: "title=false" },
		{ options: { showOwner: false }, query: "owner=false" },
		{
			options: { showTitle: false, showOwner: false },
			query: "title=false&owner=false",
		},
	])("only appends opted-out display options: $query", ({ options, query }) => {
		expect(buildEmbedCode({ ...input, options })).toBe(
			defaultCode.replace("abc123", `abc123?${query}`),
		);
		expect(buildEmbedCode({ ...input, startTime: 83.7, options })).toBe(
			defaultCode.replace("abc123", `abc123?t=83&${query}`),
		);
	});
});

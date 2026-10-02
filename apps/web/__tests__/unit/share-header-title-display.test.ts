import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	new URL("../../app/s/[videoId]/_components/ShareHeader.tsx", import.meta.url),
	"utf8",
);

function titleMarkup() {
	const start = source.indexOf("The title takes the row's slack");
	const end = source.indexOf("Holds its own width so the title");
	return source.slice(start, end);
}

describe("share header title readability", () => {
	it("keeps the full title readable at 360, 390, and 1280 without capping manual input", () => {
		const markup = titleMarkup();
		const heading = markup.slice(
			markup.indexOf("<h1"),
			markup.indexOf("</h1>"),
		);
		const controls = source.slice(
			source.indexOf("Holds its own width so the title"),
			source.indexOf("Holds its own width so the title") + 400,
		);

		expect(heading).toContain("whitespace-normal");
		expect(heading).toContain("break-words");
		expect(heading).toContain("title={displayTitle}");
		expect(heading).not.toContain("truncate");
		expect(markup).toContain("min-w-0");
		expect(markup).toContain("maxLength={255}");
		expect(controls).toContain("lg:shrink-0");
	});
});

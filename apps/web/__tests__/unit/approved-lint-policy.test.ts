import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const ledger = read("docs/LINT_EXCEPTIONS.md");
const sources = [
	...new Set(
		[...ledger.matchAll(/\| `([^`]+\.tsx)`\s+\|/g)].flatMap((match) =>
			match[1] ? [match[1]] : [],
		),
	),
];

describe("per-site lint policy", () => {
	it("keeps CI lint enforcing without changing the typechecker budget", () => {
		const workflow = read(".github/workflows/ci.yml");
		const lintJob = workflow
			.split("  lint-biome:\n")[1]
			?.split("\n  build-desktop:")[0];
		expect(lintJob).toBeDefined();
		expect(lintJob?.match(/run: (.+)/g)).toEqual(["run: biome ci ."]);
		expect(workflow).toContain("NODE_OPTIONS: --max-old-space-size=5120");
	});

	it("documents exactly the narrow rule-specific sites, with meaningful reasons", () => {
		expect(sources).toHaveLength(24);
		const counts: Record<string, number> = {};
		for (const source of sources) {
			for (const match of read(source).matchAll(
				/biome-ignore ([^:]+): ([^\n]+)/g,
			)) {
				const [, rule, reason] = match;
				if (!rule || !reason)
					throw new Error("Missing per-site rule or reason");
				expect(rule).toMatch(/^lint\/[a-z0-9]+\/[A-Za-z]+$/);
				expect(reason.length).toBeGreaterThan(60);
				counts[rule] = (counts[rule] ?? 0) + 1;
			}
		}
		expect(counts).toEqual({
			"lint/correctness/useUniqueElementIds": 14,
			"lint/suspicious/noArrayIndexKey": 8,
			"lint/a11y/noStaticElementInteractions": 3,
			"lint/a11y/useMediaCaption": 5,
			"lint/performance/noImgElement": 3,
		});
	});

	it("retains the public anchor and treats all five caption exceptions as deferred limitations", () => {
		expect(
			read("apps/web/app/(site)/self-hosting/SelfHostingPage.tsx"),
		).toContain('id="features"');
		const captions = sources.flatMap((source) => [
			...read(source).matchAll(
				/biome-ignore lint\/a11y\/useMediaCaption: ([^\n]+)/g,
			),
		]);
		expect(captions).toHaveLength(5);
		for (const match of captions) {
			expect(match[1]).toContain("Deferred accessibility limitation:");
			expect(match[1]).toContain("docs/LINT_EXCEPTIONS.md");
		}
		expect(ledger).toContain("not false positives or claims");
		expect(ledger).toContain("clip/rebase cues for trimming");
	});
});

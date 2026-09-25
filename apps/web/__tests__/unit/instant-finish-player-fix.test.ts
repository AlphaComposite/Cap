import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	replayRevisionHlsEvents,
	revisionHlsErrorAction,
} from "@/lib/revision-playback";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

describe("F12 grant refresh on origin 401", () => {
	it.each([401, 403, 410, 500, 503])(
		"refreshes a revision playlist on hls status %s",
		(status) => {
			expect(
				revisionHlsErrorAction({
					status,
					fatal: false,
					details: "fragLoadError",
					refreshAttempts: 0,
					maxRefreshAttempts: 2,
					policyDenied: false,
				}),
			).toEqual({ type: "refresh-grant" });
		},
	);

	it("reloads the newly signed playlist and fails closed after bounded retries", () => {
		expect(
			revisionHlsErrorAction({
				status: 401,
				fatal: true,
				refreshAttempts: 2,
				maxRefreshAttempts: 2,
				policyDenied: false,
			}),
		).toEqual({ type: "fail-closed" });
		expect(
			revisionHlsErrorAction({
				status: 401,
				fatal: false,
				refreshAttempts: 0,
				maxRefreshAttempts: 2,
				policyDenied: true,
			}),
		).toEqual({ type: "fail-closed" });
	});

	it("replays fake hls events into a bounded refresh then fail-closed", () => {
		expect(
			replayRevisionHlsEvents([
				{ status: 401 },
				{ status: 401 },
				{ status: 401 },
			]),
		).toEqual([
			{ type: "refresh-grant" },
			{ type: "refresh-grant" },
			{ type: "fail-closed" },
		]);
	});

	it("treats the Safari native error as the same refresh, including policy denial", () => {
		expect(
			revisionHlsErrorAction({
				native: true,
				fatal: true,
				refreshAttempts: 0,
				maxRefreshAttempts: 2,
				policyDenied: false,
			}),
		).toEqual({ type: "refresh-grant" });
		expect(
			revisionHlsErrorAction({
				native: true,
				fatal: true,
				refreshAttempts: 0,
				maxRefreshAttempts: 2,
				policyDenied: true,
			}),
		).toEqual({ type: "fail-closed" });
	});
});

describe("F7 share and embed documents do not leak grant referrers", () => {
	it("sets Referrer-Policy no-referrer on share and embed", () => {
		const config = readFileSync(path.join(root, "next.config.mjs"), "utf8");
		expect(config).toContain('source: "/s/:path*"');
		expect(config).toContain('source: "/embed/:path*"');
		expect(config).toContain('"Referrer-Policy"');
		expect(config).toContain('"no-referrer"');
		const share = readFileSync(
			path.join(root, "app/s/[videoId]/page.tsx"),
			"utf8",
		);
		const embed = readFileSync(
			path.join(root, "app/embed/[videoId]/page.tsx"),
			"utf8",
		);
		expect(share).toContain('name="referrer"');
		expect(embed).toContain('name="referrer"');
	});

	it("does not log grant-bearing player URLs", () => {
		const player = readFileSync(
			path.join(root, "app/s/[videoId]/_components/HLSVideoPlayer.tsx"),
			"utf8",
		);
		expect(player).not.toMatch(/console\.(log|error|warn)\([^)]*playbackSrc/);
		expect(player).not.toMatch(/console\.(log|error)\([^)]*,\s*data\)/);
	});
});

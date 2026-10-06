import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	beginGrantRefreshCycle,
	grantResumeStartPosition,
	hlsResumePosition,
	playbackResumeTime,
	replayRevisionHlsEvents,
	revisionHlsErrorAction,
	settleGrantRefreshCycle,
} from "@/lib/revision-playback";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

describe("F12 grant refresh on origin 401", () => {
	it.each([401, 500, 503])(
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

	it("resumes a grant refresh from the current time and coalesces a burst", () => {
		expect(grantResumeStartPosition(62.4)).toBe(62.4);
		expect(grantResumeStartPosition(0)).toBe(-1);
		expect(playbackResumeTime(78.2, 0)).toBe(78.2);
		expect(playbackResumeTime(78.2, 78.4)).toBe(78.4);
		expect(hlsResumePosition(62.4)).toBe(62.4);
		let cycle = { inFlight: false, attempts: 0 };
		const first = beginGrantRefreshCycle(cycle, 2);
		expect(first.action).toBe("refresh");
		cycle = first.cycle;
		expect(beginGrantRefreshCycle(cycle, 2).action).toBe("coalesce");
		cycle = settleGrantRefreshCycle(cycle, true);
		expect(cycle).toEqual({ inFlight: false, attempts: 0 });
		cycle = beginGrantRefreshCycle(cycle, 2).cycle;
		cycle = settleGrantRefreshCycle(cycle, false);
		cycle = beginGrantRefreshCycle(cycle, 2).cycle;
		cycle = settleGrantRefreshCycle(cycle, false);
		expect(beginGrantRefreshCycle(cycle, 2).action).toBe("fail-closed");
	});

	it("stops on privacy revocation", () => {
		expect(
			revisionHlsErrorAction({
				status: 403,
				fatal: false,
				refreshAttempts: 0,
				maxRefreshAttempts: 2,
				policyDenied: false,
			}),
		).toEqual({ type: "stop" });
		expect(
			revisionHlsErrorAction({
				status: 410,
				fatal: false,
				refreshAttempts: 0,
				maxRefreshAttempts: 2,
				policyDenied: false,
			}),
		).toEqual({ type: "stop" });
		expect(hlsResumePosition(62.4)).toBe(62.4);
		expect(hlsResumePosition(0)).toBe(-1);
	});

	it("fails closed after bounded retries or a denied policy", () => {
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

describe("grant refresh keeps the viewer's sound", () => {
	it("mutes only for autoplay, never for a grant resume", () => {
		const player = readFileSync(
			path.join(root, "app/s/[videoId]/_components/HLSVideoPlayer.tsx"),
			"utf8",
		);
		expect(player).not.toMatch(/autoplay \|\| startAt > 0\) \{\s*video\.muted = true/);
		expect(player).toContain("if (autoplay) video.muted = true;");
		expect(player).toContain("resumePlayingRef.current = !video.paused;");
	});
});

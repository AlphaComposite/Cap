import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	REVISION_MEDIA_DOWNLOAD_GRANT_TTL_SECONDS,
	REVISION_MEDIA_GRANT_TTL_SECONDS,
	signRevisionMediaGrant,
	verifyRevisionMediaGrant,
} from "@/lib/revision-media-token";

const env = {
	REVISION_MEDIA_GRANT_KEYS: "k1:grant-secret-grant-secret-grant-01",
} as unknown as NodeJS.ProcessEnv;

const now = 1_700_000_000;

const sign = (artifact?: "download") =>
	signRevisionMediaGrant(
		{
			videoId: "video1",
			revisionId: "rev1",
			publicationEpoch: 3,
			policyEpoch: 4,
			now,
			artifact,
		},
		env,
	);

describe("download grant ttl", () => {
	it("keeps playback grants at 60s and download grants at 30 minutes", () => {
		expect(REVISION_MEDIA_GRANT_TTL_SECONDS).toBe(60);
		expect(REVISION_MEDIA_DOWNLOAD_GRANT_TTL_SECONDS).toBe(30 * 60);

		const playback = verifyRevisionMediaGrant(sign(), { now, env });
		const download = verifyRevisionMediaGrant(sign("download"), {
			now: now + 120,
			env,
		});
		expect(playback.ok).toBe(true);
		expect(download.ok).toBe(true);
		if (!playback.ok || !download.ok) throw new Error("grant rejected");
		expect(playback.payload.exp - playback.payload.iat).toBe(60);
		expect(download.payload.artifact).toBe("download");
		expect(download.payload.exp - download.payload.iat).toBe(30 * 60);
		expect(verifyRevisionMediaGrant(sign(), { now: now + 70, env }).ok).toBe(
			false,
		);
		expect(
			verifyRevisionMediaGrant(sign("download"), {
				now: now + 30 * 60 + 6,
				env,
			}).ok,
		).toBe(false);
	});

	it("advertises the download expiry from the download grant constant", () => {
		const source = readFileSync(
			new URL("../../app/api/v1/[...route]/route.ts", import.meta.url),
			"utf8",
		);
		const handler = source.slice(
			source.indexOf('handle("getDownload"'),
			source.indexOf('handle("unlockCap"'),
		);
		expect(handler).toContain("REVISION_MEDIA_DOWNLOAD_GRANT_TTL_SECONDS");
		expect(handler).not.toContain("30 * 60");
	});
});

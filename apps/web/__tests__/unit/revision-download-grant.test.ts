import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://127.0.0.1:3000" },
	serverEnv: () => ({ NEXTAUTH_SECRET: "test-secret-with-enough-entropy" }),
}));
vi.mock("@/lib/server", () => ({
	runPromise: async (effect: unknown) => effect,
}));
vi.mock("@cap/database", () => ({
	db: () => ({ execute: async () => [] }),
}));
vi.mock("@cap/web-backend", () => ({
	VideosPolicy: class VideosPolicy {},
	provideOptionalAuth: <T>(effect: T) => effect,
}));

import { revisionArtifactUrl } from "@/lib/revision-media-grant";
import { verifyRevisionMediaGrant } from "@/lib/revision-media-token";

const env = {
	REVISION_MEDIA_GRANT_KEYS: "k1:grant-secret-grant-secret-grant-01",
	CAP_INSTANT_FINISH_OWNERS: "owner",
} as unknown as NodeJS.ProcessEnv;

const dialect = new MySqlDialect();

function executor(
	state = "READY",
	currentRevisionId: string | null = "revdownload01",
	durable: false | "verified" | "wrong-key" = false,
) {
	return {
		execute: async (query: Parameters<MySqlDialect["sqlToQuery"]>[0]) => {
			const text = dialect.sqlToQuery(query).sql;
			if (text.includes("metadataSnapshot")) {
				return durable
					? [
							{
								ownerId: "owner",
								videoId: "viddownload1",
								revisionId: "revdownload01",
								generation: 1,
								sourceId: "source1234",
								name: "Edited",
								publicationEpoch: 2,
								policyEpoch: 3,
								metadataSnapshot: {
									downloadArtifact: {
										validation: "verified",
										ownerId: "owner",
										videoId: "viddownload1",
										revisionId: "revdownload01",
										generation: 1,
										sourceId: "source1234",
										namespace: Array(4).fill("a".repeat(64)).join("/"),
										bucket: "private",
										key:
											durable === "wrong-key"
												? "owner/viddownload1/source/original.mp4"
												: "owner/viddownload1/private/edited/revdownload01/1/attempt.mp4",
										versionId: "version1",
										sha256: "a".repeat(64),
										size: 123,
									},
								},
							},
						]
					: [];
			}
			if (text.includes("video_publication")) {
				return [
					{
						currentRevisionId,
						generation: 1,
						currentGeneration: 1,
						publicationEpoch: 2,
						policyEpoch: 3,
					},
				];
			}
			if (text.includes("revision_artifact_status")) {
				return [{ state }];
			}
			return [];
		},
	};
}

function artifactOf(url: string | null) {
	expect(url).toBeTruthy();
	const token = new URL(url ?? "", "http://revision.local").searchParams.get(
		"t",
	);
	expect(token).toBeTruthy();
	const now = Math.floor(Date.now() / 1000);
	const verified = verifyRevisionMediaGrant(token ?? "", { now, env });
	if (!verified.ok) throw new Error(verified.denial);
	return verified.payload.artifact;
}

describe("download media grant", () => {
	beforeEach(() => {
		process.env.REVISION_MEDIA_GRANT_KEYS = env.REVISION_MEDIA_GRANT_KEYS;
		process.env.CAP_INSTANT_FINISH_OWNERS = env.CAP_INSTANT_FINISH_OWNERS;
	});

	it("selects the authorized CAP download endpoint only for a verified current receipt", async () => {
		for (const durable of [false, "verified", "wrong-key"] as const) {
			const download = await revisionArtifactUrl(
				{
					videoId: "viddownload1",
					ownerId: "owner",
					artifact: "download",
					child: "download.mp4",
					origin: "https://cap.test",
				},
				executor("READY", "revdownload01", durable),
			);
			expect(artifactOf(download)).toBe("download");
			const url = new URL(download ?? "", "https://cap.test");
			expect(url.pathname).toBe(
				durable === "verified"
					? "/api/video/edited-download"
					: "/media/viddownload1/r/revdownload01/download.mp4",
			);
			expect(download).not.toContain("attempt.mp4");
			expect(download).not.toContain("version1");
		}
	});
	it("mints a download artifact grant only on the download path", async () => {
		const download = await revisionArtifactUrl(
			{
				videoId: "viddownload1",
				ownerId: "owner",
				artifact: "download",
				child: "download.mp4",
				origin: "https://origin.test",
			},
			executor(),
		);
		expect(download).toContain("/download.mp4?t=");
		expect(artifactOf(download)).toBe("download");

		const thumbnail = await revisionArtifactUrl(
			{
				videoId: "viddownload1",
				ownerId: "owner",
				artifact: "thumbnail",
				child: "thumbnail.jpg",
			},
			executor(),
		);
		expect(artifactOf(thumbnail)).toBeUndefined();
		expect(
			thumbnail?.startsWith(
				"/media/viddownload1/r/revdownload01/thumbnail.jpg?t=",
			),
		).toBe(true);
	});
	it.each([
		{ state: "PENDING", currentRevisionId: "revdownload01" },
		{ state: "READY", currentRevisionId: null },
	])(
		"does not mint a thumbnail for $state with publication $currentRevisionId",
		async ({ state, currentRevisionId }) => {
			const thumbnail = await revisionArtifactUrl(
				{
					videoId: "viddownload1",
					ownerId: "owner",
					artifact: "thumbnail",
					child: "thumbnail.jpg",
				},
				executor(state, currentRevisionId),
			);
			expect(thumbnail).toBeNull();
		},
	);
});

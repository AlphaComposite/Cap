import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://127.0.0.1:3000" },
	serverEnv: () => ({ NEXTAUTH_SECRET: "test-secret-with-enough-entropy" }),
}));
vi.mock("@/lib/server", () => ({
	runPromise: async (effect: unknown) => effect,
}));
vi.mock("@cap/database", () => ({ db: () => ({}) }));
vi.mock("@cap/web-backend", () => ({
	VideosPolicy: class VideosPolicy {},
	provideOptionalAuth: <T>(effect: T) => effect,
}));

import {
	classifyLiveGrant,
	denyFlaggedPresign,
	evaluateGrantIssue,
	issueGrantForPublication,
} from "@/lib/revision-media-grant";
import {
	evaluatePresentedGrant,
	getRevisionPlaybackUrl,
	redactGrantBearer,
	signInternalServiceRequest,
	signRevisionMediaGrant,
	verifyInternalServiceRequest,
	verifyRevisionMediaGrant,
} from "@/lib/revision-media-token";
import {
	createMemoryJournal,
	inventoryExposedKeys,
	type ObjectStore,
	privateKeyFor,
	RelocationCrash,
	reconcileRelocations,
	relocateKey,
	resolveLegacySourceKey,
	sha256Bytes,
} from "@/lib/source-relocation";

const env = {
	REVISION_MEDIA_GRANT_KEYS:
		"v2:rotated-secret-rotated-secret-32b,v1:current-secret-current-secret-32b",
	REVISION_ORIGIN_SERVICE_SECRET: "service-secret-not-a-viewer-key-32",
	CAP_INSTANT_FINISH_OWNERS: "owner-flagged",
} as unknown as NodeJS.ProcessEnv;

const live = {
	videoId: "video1",
	revisionId: "rev1",
	publicationEpoch: 3,
	policyEpoch: 4,
	currentRevisionId: "rev1",
	deleted: false,
	privateOrUnauthorized: false,
};

const sign = (now = 1_700_000_000) =>
	signRevisionMediaGrant(
		{
			videoId: "video1",
			revisionId: "rev1",
			publicationEpoch: 3,
			policyEpoch: 4,
			now,
		},
		env,
	);

describe("revision media grants", () => {
	it("signs canonical base64url payload and verifies with a rotated key ring", () => {
		const token = sign();
		const [payload, signature] = token.split(".");
		expect(payload).toBeTruthy();
		expect(signature).toBeTruthy();
		expect(token).not.toContain("current-secret");
		expect(token).not.toContain("source/original");
		const verified = verifyRevisionMediaGrant(token, {
			now: 1_700_000_030,
			env,
		});
		expect(verified.ok).toBe(true);
		if (verified.ok) {
			expect(verified.payload.v).toBe(1);
			expect(verified.payload.exp - verified.payload.iat).toBe(60);
		}
	});

	it("rejects malformed, forged, skewed, and expired tokens", () => {
		expect(verifyRevisionMediaGrant("nope", { env })).toEqual({
			ok: false,
			denial: "malformed",
		});
		const token = sign();
		const forged = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
		expect(
			verifyRevisionMediaGrant(forged, { now: 1_700_000_000, env }),
		).toMatchObject({ ok: false, denial: "forged" });
		expect(
			verifyRevisionMediaGrant(token, { now: 1_700_000_000 - 30, env }),
		).toMatchObject({ ok: false, denial: "skew" });
		expect(
			verifyRevisionMediaGrant(token, { now: 1_700_000_000 + 70, env }),
		).toMatchObject({ ok: false, denial: "expired" });
	});

	it("returns 410 for old publication or policy epochs and 403 for the wrong video", () => {
		const token = sign();
		const verified = verifyRevisionMediaGrant(token, {
			now: 1_700_000_000,
			env,
		});
		expect(
			evaluatePresentedGrant(verified, { ...live, policyEpoch: 5 }),
		).toMatchObject({ status: 410 });
		expect(
			evaluatePresentedGrant(verified, {
				...live,
				currentRevisionId: "rev2",
			}),
		).toMatchObject({ status: 410, denial: "stale_publication" });
		expect(
			evaluatePresentedGrant(verified, { ...live, deleted: true }),
		).toMatchObject({ status: 410 });
		expect(
			classifyLiveGrant(
				token,
				{ ...live, videoId: "other" },
				{
					now: 1_700_000_000,
					env,
				},
			),
		).toMatchObject({ status: 403 });
	});

	it("refreshes after 60 seconds with a new grant id and does not leak the bearer", () => {
		const first = sign(1_700_000_000);
		const second = sign(1_700_000_061);
		expect(first).not.toBe(second);
		expect(
			verifyRevisionMediaGrant(first, { now: 1_700_000_070, env }).ok,
		).toBe(false);
		expect(
			verifyRevisionMediaGrant(second, { now: 1_700_000_070, env }).ok,
		).toBe(true);
		const url = getRevisionPlaybackUrl({
			videoId: "video1",
			revisionId: "rev1",
			grant: second,
			origin: "https://cap.example",
		});
		expect(url).toContain("/media/video1/r/rev1/playlist.m3u8?t=");
		expect(url).not.toContain("current-secret");
		expect(url).not.toContain("sha256");
		expect(redactGrantBearer(`play ${url}`)).not.toContain(second);
	});

	it("keeps internal service auth distinct from the viewer grant", () => {
		const service = signInternalServiceRequest(
			{ method: "GET", path: "/internal/warm", now: 1_700_000_000 },
			env,
		);
		expect(
			verifyInternalServiceRequest(
				service,
				{ method: "GET", path: "/internal/warm", now: 1_700_000_000 },
				env,
			),
		).toBe(true);
		expect(verifyRevisionMediaGrant(service, { env }).ok).toBe(false);
		expect(
			verifyInternalServiceRequest(
				sign(),
				{ method: "GET", path: "/internal/warm", now: 1_700_000_000 },
				env,
			),
		).toBe(false);
	});

	it("applies VideosPolicy results instead of public=true", () => {
		const publication = {
			currentRevisionId: "rev1",
			generation: 1,
			publicationEpoch: 3,
			policyEpoch: 4,
		};
		expect(
			evaluateGrantIssue({
				flagged: true,
				policy: "allow",
				publication,
				videoPublic: false,
			}),
		).toMatchObject({ ok: true, revisionId: "rev1" });
		expect(
			evaluateGrantIssue({
				flagged: true,
				policy: "password",
				publication,
				videoPublic: true,
			}),
		).toMatchObject({ status: 403 });
		expect(
			evaluateGrantIssue({
				flagged: true,
				policy: "deny",
				publication,
				videoPublic: true,
			}),
		).toMatchObject({ status: 403 });
		expect(
			evaluateGrantIssue({
				flagged: true,
				policy: "missing",
				publication,
			}),
		).toMatchObject({ status: 410 });
		expect(
			evaluateGrantIssue({
				flagged: false,
				policy: "allow",
				publication,
			}),
		).toEqual({ enabled: false });
		expect(
			evaluateGrantIssue({
				flagged: true,
				policy: "allow",
				publication: "missing_table",
			}),
		).toMatchObject({ status: 503 });
	});

	it("denies flagged presigns and raw preview without editing the playlist route", () => {
		const previous = process.env.CAP_INSTANT_FINISH_OWNERS;
		process.env.CAP_INSTANT_FINISH_OWNERS = "owner-flagged";
		expect(
			denyFlaggedPresign({
				ownerId: "owner-flagged",
				videoId: "video1",
				videoType: "raw-preview",
			}),
		).toEqual({ deny: true, status: 404 });
		expect(
			denyFlaggedPresign({
				ownerId: "owner-flagged",
				videoId: "video1",
				key: "owner-flagged/video1/result.mp4",
			}).deny,
		).toBe(true);
		expect(
			denyFlaggedPresign({
				ownerId: "other-owner",
				videoId: "video1",
				key: "other-owner/video1/result.mp4",
			}),
		).toEqual({ deny: false });
		const issued = issueGrantForPublication({
			videoId: "video1",
			revisionId: "rev1",
			publicationEpoch: 3,
			policyEpoch: 4,
			now: 1_700_000_000,
			env,
			child: "download.mp4",
		});
		expect(issued.playbackUrl).toContain("download.mp4?t=");
		expect(issued.playbackUrl).not.toContain("result.mp4");
		process.env.CAP_INSTANT_FINISH_OWNERS = previous;
	});
});

describe("source relocation", () => {
	function memoryStore(seed: Record<string, string>): ObjectStore & {
		objects: Map<string, Uint8Array>;
		urls: Map<string, string>;
	} {
		const objects = new Map(
			Object.entries(seed).map(([key, value]) => [
				key,
				new TextEncoder().encode(value),
			]),
		);
		const urls = new Map<string, string>();
		return {
			objects,
			urls,
			async copy(oldKey, newKey) {
				const bytes = objects.get(oldKey);
				if (!bytes) throw new Error("missing source");
				objects.set(newKey, bytes);
			},
			async sha256(key) {
				const bytes = objects.get(key);
				return bytes ? sha256Bytes(bytes) : null;
			},
			async deleteAllVersions(key) {
				objects.delete(key);
			},
			async exists(key) {
				return objects.has(key);
			},
			async presignGet(key) {
				const url = `http://127.0.0.1:13010/cap/${encodeURIComponent(key)}?sig=test`;
				urls.set(url, key);
				return url;
			},
			async request(url) {
				const key = urls.get(url);
				if (!key || !objects.has(key)) return 403;
				return 200;
			},
		};
	}

	async function runCrash(
		point: "after_intent" | "after_copy" | "after_pointer" | "after_delete",
	) {
		const oldKey = "owner/video1/source/original.mp4";
		const store = memoryStore({ [oldKey]: "original-bytes" });
		const journal = createMemoryJournal();
		const preissuedUrl = await store.presignGet(oldKey);
		const newKey = privateKeyFor("original", "video1");
		await expect(
			relocateKey({
				videoId: "video1",
				revisionId: "rev1",
				oldKey,
				newKey,
				kind: "original",
				store,
				journal,
				preissuedUrl,
				purge: {
					async purge() {
						return { accepted: true };
					},
				},
				purgeUrls: [`https://s3.example/cap/${oldKey}`],
				crash: point,
				flagged: true,
			}),
		).rejects.toBeInstanceOf(RelocationCrash);
		await reconcileRelocations({
			store,
			journal,
			kindFor: () => "original",
			purge: {
				async purge() {
					return { accepted: true };
				},
			},
			purgeUrlsFor: () => [`https://s3.example/cap/${oldKey}`],
			preissuedUrlFor: () => preissuedUrl,
		});
		expect(store.objects.has(oldKey)).toBe(false);
		expect(store.objects.has(newKey)).toBe(true);
		expect(await store.sha256(newKey)).toBe(
			sha256Bytes(new TextEncoder().encode("original-bytes")),
		);
		expect(await store.request(preissuedUrl, "GET")).toBe(403);
		expect(await store.request(preissuedUrl, "HEAD")).toBe(403);
		expect(journal.live.get("video1")?.liveKey).toBe(newKey);
		expect(journal.rows[0]?.state).toBe("PURGED");
	}

	it("reconciles crashes after intent, copy, pointer, and delete", async () => {
		await runCrash("after_intent");
		await runCrash("after_copy");
		await runCrash("after_pointer");
		await runCrash("after_delete");
	});

	it("refuses relocation while the flag is off and keeps the legacy key", async () => {
		const oldKey = "owner/video1/result.mp4";
		const store = memoryStore({ [oldKey]: "render" });
		await expect(
			relocateKey({
				videoId: "video1",
				revisionId: "rev1",
				oldKey,
				newKey: privateKeyFor("rollback", "video1"),
				kind: "rollback",
				store,
				journal: createMemoryJournal(),
				flagged: false,
			}),
		).rejects.toThrow("flag is off");
		expect(store.objects.has(oldKey)).toBe(true);
		expect(
			resolveLegacySourceKey({
				sourceKey: oldKey,
				liveKey: "private/source/video1/abc",
				relocations: [
					{ oldKey, newKey: "private/source/video1/abc", state: "DELETED" },
				],
			}),
		).toBe("private/source/video1/abc");
	});

	it("inventories exposed original, raw, result, and alias keys", () => {
		const keys = inventoryExposedKeys({
			ownerId: "owner",
			videoId: "video1",
			sourceKey: "owner/video1/source/original.mp4",
			rawFileKey: "owner/video1/raw-upload.mp4",
			outputKey: "owner/video1/.recording/result.mp4",
			thumbnailKey: "owner/video1/screenshot/screen-capture.jpg",
		}).map((item) => item.key);
		expect(keys).toContain("owner/video1/result.mp4");
		expect(keys).toContain("owner/video1/raw-upload.mp4");
		expect(keys).not.toContain("private/source/video1/already");
	});
});

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodePeaksObject } from "@/lib/waveform-peaks";
import {
	authorizePeaksRead,
	peaksReadHeaders,
} from "@/lib/waveform-peaks-access";

const SHA = "ab".repeat(32);
const peaks = encodePeaksObject({
	sourceSha256: SHA,
	pairs: [{ min: -12, max: 12 }],
});

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	video: vi.fn(),
	source: vi.fn(),
	edits: vi.fn(async () => []),
	intent: vi.fn<() => Promise<Array<{ canonicalSpec: unknown }>>>(
		async () => [],
	),
	head: vi.fn(),
	read: vi.fn(),
	flagged: vi.fn(() => true),
	generate: vi.fn(),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.user,
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: { kind?: string; sha256?: unknown }) => {
				const rows = () => {
					if (table?.kind === "source" || "sha256" in (table ?? {})) {
						return mocks.source();
					}
					if (table?.kind === "edits") return mocks.edits();
					if (table?.kind === "intent") return mocks.intent();
					return mocks.video();
				};
				const chain = {
					where: () => Promise.resolve(rows()),
					innerJoin: () => chain,
				};
				return chain;
			},
		}),
	}),
}));
vi.mock("drizzle-orm", () => ({
	and: () => ({ and: true }),
	eq: () => ({ eq: true }),
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "id", kind: "videos" },
	sourceObject: { sha256: "sha256", videoId: "videoId", kind: "source" },
	videoEdits: { editSpec: "editSpec", kind: "edits" },
	editIntent: { canonicalSpec: "canonicalSpec", kind: "intent" },
	videoPublication: { videoId: "videoId", kind: "publication" },
	editRevision: { revisionId: "revisionId", kind: "revision" },
}));
vi.mock("@cap/web-domain", () => ({
	Video: { VideoId: { make: (value: string) => value } },
}));
vi.mock("@/lib/instant-finish-flag", () => ({
	isInstantFinishEnabledForOwner: mocks.flagged,
}));
vi.mock("@/lib/waveform-peaks-store", () => ({
	headPeaksObject: mocks.head,
	readPeaksObject: mocks.read,
}));

vi.mock("@/lib/revision-publication-origin", () => ({
	requestSourcePeaks: mocks.generate,
	prepareSourceOnEditorOpen: mocks.generate,
}));

function expectPrivate(response: Response) {
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	expect(response.headers.get("Cache-Control")).not.toContain("31536000");
	expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
}

function request(method: "GET" | "HEAD", query = "videoId=video-ready-01") {
	return new NextRequest(`http://localhost/api/media/peaks?${query}`, {
		method,
	});
}

describe("peaks read authorization", () => {
	it("refuses anonymous and grant-only callers, and a wrong owner", () => {
		expect(
			authorizePeaksRead({
				userId: null,
				ownerId: "owner-1",
				videoFound: true,
				flagged: true,
				registeredSha: SHA,
				videoId: "video-ready-01",
			}).status,
		).toBe(401);
		expect(
			authorizePeaksRead({
				userId: null,
				ownerId: "owner-1",
				videoFound: true,
				flagged: true,
				registeredSha: SHA,
				videoId: "video-ready-01",
			}).status,
		).toBe(401);
		expect(
			authorizePeaksRead({
				userId: "other",
				ownerId: "owner-1",
				videoFound: true,
				flagged: true,
				registeredSha: SHA,
				videoId: "video-ready-01",
			}).status,
		).toBe(403);
		expect(
			authorizePeaksRead({
				userId: "owner-1",
				ownerId: null,
				videoFound: false,
				flagged: true,
				registeredSha: SHA,
				videoId: "video-ready-01",
			}).status,
		).toBe(410);
	});

	it("uses private no-store headers and never a year-long cache", () => {
		const headers = peaksReadHeaders();
		expect(headers.get("Cache-Control")).toBe("private, no-store");
		expect(headers.get("Cache-Control")).not.toContain("31536000");
		expect(headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
	});
});

describe("peaks owner route", () => {
	beforeEach(() => {
		mocks.user.mockReset();
		mocks.video.mockReset();
		mocks.source.mockReset();
		mocks.head.mockReset();
		mocks.read.mockReset();
		mocks.flagged.mockReturnValue(true);
		mocks.edits.mockResolvedValue([]);
		mocks.intent.mockResolvedValue([]);
		mocks.generate.mockReset();
		mocks.video.mockResolvedValue([{ ownerId: "owner-1", duration: 0.01 }]);
		mocks.source.mockResolvedValue([{ sha256: SHA }]);
		mocks.head.mockResolvedValue({ contentLength: peaks.byteLength });
		mocks.read.mockResolvedValue(peaks);
	});

	it("returns 401 for anonymous and grant-token callers without reading the object", async () => {
		mocks.user.mockResolvedValue(null);
		const { GET } = await import("@/app/api/media/peaks/route");
		const response = await GET(
			request("GET", "videoId=video-ready-01&token=grant"),
		);
		expect(response.status).toBe(401);
		expect(mocks.read).not.toHaveBeenCalled();
		expect(mocks.head).not.toHaveBeenCalled();
	});

	it("returns 403 for a different owner", async () => {
		mocks.user.mockResolvedValue({ id: "other" });
		const { GET } = await import("@/app/api/media/peaks/route");
		expect((await GET(request("GET"))).status).toBe(403);
	});

	it("returns the same private headers for owner GET and HEAD, and HEAD has no body", async () => {
		mocks.user.mockResolvedValue({ id: "owner-1" });
		const { GET, HEAD } = await import("@/app/api/media/peaks/route");
		const got = await GET(request("GET"));
		const head = await HEAD(request("HEAD"));
		expect(got.status).toBe(200);
		expect(head.status).toBe(200);
		expect(got.headers.get("Cache-Control")).toBe("private, no-store");
		expect(head.headers.get("Cache-Control")).toBe(
			got.headers.get("Cache-Control"),
		);
		expect(head.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(head.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(await head.text()).toBe("");
		expect(new Uint8Array(await got.arrayBuffer())).toEqual(peaks);
		expect(mocks.read).toHaveBeenCalledTimes(2);
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("rejects a same-length bad object on GET and HEAD and never caches denials", async () => {
		mocks.user.mockResolvedValue({ id: "owner-1" });
		const bad = new Uint8Array(peaks.byteLength);
		bad.set(peaks);
		bad[0] = 0;
		mocks.read.mockResolvedValue(bad);
		mocks.head.mockResolvedValue({ contentLength: bad.byteLength });
		const { GET, HEAD } = await import("@/app/api/media/peaks/route");
		const got = await GET(request("GET"));
		const head = await HEAD(request("HEAD"));
		expect(got.status).toBe(404);
		expect(head.status).toBe(got.status);
		expect(await head.text()).toBe("");
		expectPrivate(got);
		expectPrivate(head);
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("rejects source sha, count, and duration mismatches on both methods", async () => {
		mocks.user.mockResolvedValue({ id: "owner-1" });
		mocks.video.mockResolvedValue([{ ownerId: "owner-1", duration: 10 }]);
		const { GET, HEAD } = await import("@/app/api/media/peaks/route");
		const got = await GET(request("GET"));
		const head = await HEAD(request("HEAD"));
		expect(got.status).not.toBe(200);
		expect(head.status).toBe(got.status);
		expectPrivate(head);
		expect(await head.text()).toBe("");
	});

	it("uses the edit-spec source duration when the video row differs", async () => {
		mocks.user.mockResolvedValue({ id: "owner-1" });
		mocks.video.mockResolvedValue([{ ownerId: "owner-1", duration: 10 }]);
		mocks.intent.mockResolvedValue([
			{
				canonicalSpec: {
					version: 2,
					sourceDuration: 0.01,
					keepRanges: [{ start: 0, end: 0.01 }],
					manualKeepRanges: [{ start: 0, end: 0.01 }],
					autoCuts: {
						silence: {
							enabled: false,
							ranges: [],
							thresholdMs: 600,
							padMs: 100,
							removedMs: 0,
							gapCount: 0,
						},
						fillers: {
							enabled: false,
							ranges: [],
							mode: "ums",
							padMs: 0,
							removedCount: 0,
							skippedCount: 0,
						},
					},
				},
			},
		]);
		const { GET, HEAD } = await import("@/app/api/media/peaks/route");
		const got = await GET(request("GET"));
		const head = await HEAD(request("HEAD"));
		expect(got.status).toBe(200);
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("denies a changed registered source on GET and HEAD without generating peaks", async () => {
		mocks.user.mockResolvedValue({ id: "owner-1" });
		mocks.source.mockResolvedValue([{ sha256: "cd".repeat(32) }]);
		const { GET, HEAD } = await import("@/app/api/media/peaks/route");
		const got = await GET(request("GET"));
		const head = await HEAD(request("HEAD"));
		expect(got.status).toBe(404);
		expect(head.status).toBe(404);
		expect(await head.text()).toBe("");
		expectPrivate(got);
		expectPrivate(head);
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("attaches private no-store headers to anonymous, other-owner, and missing-video responses", async () => {
		const { GET, HEAD } = await import("@/app/api/media/peaks/route");
		mocks.user.mockResolvedValue(null);
		const anon = await HEAD(
			request("HEAD", "videoId=video-ready-01&token=grant"),
		);
		expect(anon.status).toBe(401);
		expectPrivate(anon);
		expect(await anon.text()).toBe("");
		mocks.user.mockResolvedValue({ id: "other" });
		const other = await GET(request("GET"));
		expect(other.status).toBe(403);
		expectPrivate(other);
		mocks.user.mockResolvedValue({ id: "owner-1" });
		mocks.video.mockResolvedValue([]);
		const missing = await GET(request("GET"));
		expect(missing.status).toBe(410);
		expectPrivate(missing);
		expect(mocks.read).not.toHaveBeenCalled();
		expect(mocks.generate).not.toHaveBeenCalled();
	});
});

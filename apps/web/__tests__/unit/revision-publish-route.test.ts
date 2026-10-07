import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://127.0.0.1:32120" },
	serverEnv: () => ({
		NEXTAUTH_SECRET: "test-secret-with-enough-entropy",
		WEB_URL: "http://127.0.0.1:32120",
	}),
}));

import { RevisionPublicationError } from "@/lib/revision-publication";

const publishOwnerRevision = vi.hoisted(() => vi.fn());
const prepareOwnerRevision = vi.hoisted(() => vi.fn());
const failUnjoinedInflightPrepare = vi.hoisted(() => vi.fn());

vi.mock("@/lib/revision-publish", () => ({
	publishOwnerRevision,
	prepareOwnerRevision,
	parseRevisionRouteBody: (body: unknown) => {
		if (!body || typeof body !== "object") return null;
		const record = body as Record<string, unknown>;
		if (typeof record.videoId !== "string") return null;
		return record;
	},
}));

vi.mock("@/lib/revision-prepare-abort", () => ({
	failUnjoinedInflightPrepare,
}));

const playback = {
	playlistUrl:
		"http://127.0.0.1:32120/media/video-1/r/rev-1/playlist.m3u8?t=grant",
	grantExpiresAt: 1_700_000_000_000,
	revisionMetadata: { playlistPath: "/media/video-1/r/rev-1/playlist.m3u8" },
};

function request(
	url: string,
	init: {
		origin?: string;
		host?: string;
		contentType?: string;
		body?: unknown;
		signal?: AbortSignal;
	},
) {
	const headers = new Headers();
	if (init.contentType !== undefined) {
		headers.set("content-type", init.contentType);
	}
	if (init.origin) headers.set("origin", init.origin);
	if (init.host) {
		headers.set("host", init.host);
		headers.set("x-forwarded-host", init.host);
	}
	return new NextRequest(url, {
		method: "POST",
		headers,
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
		signal: init.signal,
	});
}

const sameOrigin = {
	origin: "http://127.0.0.1:32120",
	host: "127.0.0.1:32120",
	contentType: "application/json",
	body: {
		videoId: "video-1",
		editSpec: { version: 2 },
		baseGeneration: 1,
		draftVersion: 2,
		draftSession: "editor",
	},
};

describe("revision publish route", () => {
	beforeEach(() => {
		publishOwnerRevision.mockReset();
		prepareOwnerRevision.mockReset();
	});

	it("rejects a cross-origin publish", async () => {
		const { POST } = await import("@/app/api/video/revision/publish/route");
		const response = await POST(
			request("http://127.0.0.1:32120/api/video/revision/publish", {
				...sameOrigin,
				origin: "http://evil.example",
			}),
		);
		expect(response.status).toBe(403);
		expect(publishOwnerRevision).not.toHaveBeenCalled();
	});

	it("rejects a non-JSON publish", async () => {
		const { POST } = await import("@/app/api/video/revision/publish/route");
		const response = await POST(
			request("http://127.0.0.1:32120/api/video/revision/publish", {
				...sameOrigin,
				contentType: "text/plain",
			}),
		);
		expect(response.status).toBe(415);
		expect(publishOwnerRevision).not.toHaveBeenCalled();
	});

	it("returns the playback payload from a same-origin publish", async () => {
		publishOwnerRevision.mockResolvedValue({
			success: true,
			revisionId: "rev-1",
			generation: 4,
			playback,
		});
		const { POST } = await import("@/app/api/video/revision/publish/route");
		const response = await POST(
			request("http://127.0.0.1:32120/api/video/revision/publish", sameOrigin),
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			success: true,
			revisionId: "rev-1",
			generation: 4,
			playback,
		});
		expect(publishOwnerRevision).toHaveBeenCalledOnce();
	});

	it("maps a publication 409 to the response status", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		publishOwnerRevision.mockRejectedValue(
			new RevisionPublicationError(409, "generation 1 != 2"),
		);
		const { POST } = await import("@/app/api/video/revision/publish/route");
		const response = await POST(
			request("http://127.0.0.1:32120/api/video/revision/publish", sameOrigin),
		);
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error: "generation 1 != 2",
		});
		expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
			"[revision/publish] conflict",
			{ videoId: "video-1", message: "generation 1 != 2" },
		);
	});

	it("returns 499 Prepare aborted for an aborted sibling prepare and logs the cause", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		publishOwnerRevision.mockRejectedValue(
			Object.assign(new Error("storage"), {
				cause: new DOMException("The operation was aborted.", "AbortError"),
			}),
		);
		const { POST } = await import("@/app/api/video/revision/publish/route");
		const response = await POST(
			request("http://127.0.0.1:32120/api/video/revision/publish", sameOrigin),
		);
		expect(response.status).toBe(499);
		await expect(response.json()).resolves.toEqual({
			error: "Prepare aborted",
		});
		expect(errorSpy).toHaveBeenCalled();
		const logged = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
		expect(logged).toContain("AbortError");
		expect(logged).not.toMatch(/MYSQL_PWD|AWS_SECRET|password/i);
		errorSpy.mockRestore();
	});

	it("still returns 500 and a toast body for a real publish error", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		publishOwnerRevision.mockRejectedValue(new Error("database unavailable"));
		const { POST } = await import("@/app/api/video/revision/publish/route");
		const response = await POST(
			request("http://127.0.0.1:32120/api/video/revision/publish", sameOrigin),
		);
		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			error: "Revision request failed",
		});
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});

describe("revision prepare route", () => {
	beforeEach(() => {
		prepareOwnerRevision.mockReset();
		failUnjoinedInflightPrepare.mockReset();
		failUnjoinedInflightPrepare.mockResolvedValue({
			markedFailed: false,
			joined: false,
		});
	});

	it("logs a preparation 409 with only the video ID and message", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		prepareOwnerRevision.mockRejectedValue(
			new RevisionPublicationError(
				409,
				"Registered source is not ready; retry",
			),
		);
		const { POST } = await import("@/app/api/video/revision/prepare/route");
		const response = await POST(
			request("http://127.0.0.1:32120/api/video/revision/prepare", sameOrigin),
		);
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toEqual({
			error: "Registered source is not ready; retry",
		});
		expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
			"[revision/prepare] conflict",
			{ videoId: "video-1", message: "Registered source is not ready; retry" },
		);
	});

	it("returns only revisionId and generation", async () => {
		prepareOwnerRevision.mockResolvedValue({
			success: true,
			revisionId: "rev-2",
			generation: 5,
			playback: playback,
		});
		const { POST } = await import("@/app/api/video/revision/prepare/route");
		const response = await POST(
			request("http://127.0.0.1:32120/api/video/revision/prepare", sameOrigin),
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			revisionId: "rev-2",
			generation: 5,
		});
	});

	it("rejects a missing origin", async () => {
		const { POST } = await import("@/app/api/video/revision/prepare/route");
		const response = await POST(
			request("http://127.0.0.1:32120/api/video/revision/prepare", {
				...sameOrigin,
				origin: undefined,
			}),
		);
		expect(response.status).toBe(403);
		expect(prepareOwnerRevision).not.toHaveBeenCalled();
	});

	it("marks the revision failed when the request aborts and no publish joined", async () => {
		const controller = new AbortController();
		prepareOwnerRevision.mockImplementation(() => {
			controller.abort();
			return new Promise(() => {});
		});
		failUnjoinedInflightPrepare.mockResolvedValue({
			markedFailed: true,
			joined: false,
		});
		const { POST } = await import("@/app/api/video/revision/prepare/route");
		const pending = POST(
			request("http://127.0.0.1:32120/api/video/revision/prepare", {
				...sameOrigin,
				signal: controller.signal,
			}),
		);
		controller.abort();
		const response = await pending;
		expect(response.status).toBe(499);
		expect(failUnjoinedInflightPrepare).toHaveBeenCalledWith({
			videoId: "video-1",
		});
	});

	it("does not fail a prepare a publish has joined", async () => {
		const controller = new AbortController();
		prepareOwnerRevision.mockImplementation(async () => {
			controller.abort();
			return {
				success: true,
				revisionId: "rev-joined",
				generation: 6,
			};
		});
		failUnjoinedInflightPrepare.mockResolvedValue({
			markedFailed: false,
			joined: true,
		});
		const { POST } = await import("@/app/api/video/revision/prepare/route");
		const pending = POST(
			request("http://127.0.0.1:32120/api/video/revision/prepare", {
				...sameOrigin,
				signal: controller.signal,
			}),
		);
		const response = await pending;
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			revisionId: "rev-joined",
			generation: 6,
		});
		expect(failUnjoinedInflightPrepare).toHaveBeenCalledWith({
			videoId: "video-1",
		});
	});

	it("aborts the origin call when an unjoined prepare is aborted", async () => {
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		prepareOwnerRevision.mockImplementation((_input, options) => {
			seen = options?.signal;
			controller.abort();
			return new Promise(() => {});
		});
		failUnjoinedInflightPrepare.mockResolvedValue({
			markedFailed: true,
			joined: false,
		});
		const { POST } = await import("@/app/api/video/revision/prepare/route");
		const response = await POST(
			request("http://127.0.0.1:32120/api/video/revision/prepare", {
				...sameOrigin,
				signal: controller.signal,
			}),
		);
		expect(response.status).toBe(499);
		expect(seen?.aborted).toBe(true);
	});

	it("does not abort the origin call when a publish has joined", async () => {
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		prepareOwnerRevision.mockImplementation(async (_input, options) => {
			seen = options?.signal;
			controller.abort();
			return {
				success: true,
				revisionId: "rev-joined",
				generation: 6,
			};
		});
		failUnjoinedInflightPrepare.mockResolvedValue({
			markedFailed: false,
			joined: true,
		});
		const { POST } = await import("@/app/api/video/revision/prepare/route");
		const response = await POST(
			request("http://127.0.0.1:32120/api/video/revision/prepare", {
				...sameOrigin,
				signal: controller.signal,
			}),
		);
		expect(response.status).toBe(200);
		expect(seen?.aborted).toBe(false);
	});
});

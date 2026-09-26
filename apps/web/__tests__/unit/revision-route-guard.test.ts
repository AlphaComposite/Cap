import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const { env } = vi.hoisted(() => ({
	env: { WEB_URL: "https://cap.styrir.com" },
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: env.WEB_URL }),
}));

import { revisionRouteDenial } from "@/lib/revision-route-guard";

function request(
	headers: Record<string, string>,
	url = "https://cap.styrir.com/api/video/revision/publish",
) {
	return new NextRequest(url, {
		method: "POST",
		headers,
	});
}

describe("revision route CSRF guard", () => {
	it("rejects a content-type parameter that only contains application/json", () => {
		const denied = revisionRouteDenial(
			request({
				"content-type": "text/plain;x=application/json",
				origin: "https://cap.styrir.com",
			}),
		);
		expect(denied?.status).toBe(415);
	});

	it("rejects an http origin against the https canonical origin", () => {
		const denied = revisionRouteDenial(
			request({
				"content-type": "application/json",
				origin: "http://cap.styrir.com",
				"x-forwarded-host": "cap.styrir.com",
			}),
		);
		expect(denied?.status).toBe(403);
	});

	it("rejects a spoofed X-Forwarded-Host and a missing or null origin", () => {
		expect(
			revisionRouteDenial(
				request({
					"content-type": "application/json",
					origin: "https://evil.example",
					"x-forwarded-host": "cap.styrir.com",
					host: "cap.styrir.com",
				}),
			)?.status,
		).toBe(403);
		expect(
			revisionRouteDenial(request({ "content-type": "application/json" }))
				?.status,
		).toBe(403);
		expect(
			revisionRouteDenial(
				request({
					"content-type": "application/json",
					origin: "null",
				}),
			)?.status,
		).toBe(403);
	});

	it("accepts application/json from the canonical scheme and host", () => {
		expect(
			revisionRouteDenial(
				request({
					"content-type": "application/json; charset=utf-8",
					origin: "https://cap.styrir.com",
					"x-forwarded-host": "evil.example",
				}),
			),
		).toBeNull();
	});

	it("rejects cross-site and same-site fetch metadata and accepts same-origin", () => {
		const headers = {
			"content-type": "application/json",
			origin: "https://cap.styrir.com",
		};
		expect(
			revisionRouteDenial(
				request({ ...headers, "sec-fetch-site": "cross-site" }),
			)?.status,
		).toBe(403);
		expect(
			revisionRouteDenial(
				request({ ...headers, "sec-fetch-site": "same-site" }),
			)?.status,
		).toBe(403);
		expect(
			revisionRouteDenial(
				request({ ...headers, "sec-fetch-site": "same-origin" }),
			),
		).toBeNull();
		expect(revisionRouteDenial(request(headers))).toBeNull();
	});

	it("includes a non-default port in the origin comparison", () => {
		env.WEB_URL = "http://127.0.0.1:36220";
		try {
			expect(
				revisionRouteDenial(
					request(
						{
							"content-type": "application/json",
							origin: "http://127.0.0.1",
						},
						"http://127.0.0.1:36220/api/video/revision/publish",
					),
				)?.status,
			).toBe(403);
			expect(
				revisionRouteDenial(
					request(
						{
							"content-type": "application/json",
							origin: "http://127.0.0.1:36220",
						},
						"http://127.0.0.1:36220/api/video/revision/publish",
					),
				),
			).toBeNull();
		} finally {
			env.WEB_URL = "https://cap.styrir.com";
		}
	});
});

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.example.com" }),
}));

import { revisionRouteDenial } from "@/lib/revision-route-guard";

function request(headers: Record<string, string>) {
	return new NextRequest("https://cap.example.com/api/video/revision/publish", {
		method: "POST",
		headers,
	});
}

describe("revision route CSRF guard", () => {
	it("rejects a content-type parameter that only contains application/json", () => {
		const denied = revisionRouteDenial(
			request({
				"content-type": "text/plain;x=application/json",
				origin: "https://cap.example.com",
			}),
		);
		expect(denied?.status).toBe(415);
	});

	it("rejects an http origin against the https canonical origin", () => {
		const denied = revisionRouteDenial(
			request({
				"content-type": "application/json",
				origin: "https://cap.example.com",
				"x-forwarded-host": "cap.example.com",
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
					"x-forwarded-host": "cap.example.com",
					host: "cap.example.com",
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
					origin: "https://cap.example.com",
					"x-forwarded-host": "evil.example",
				}),
			),
		).toBeNull();
	});
});

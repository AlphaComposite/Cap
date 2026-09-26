import { serverEnv } from "@cap/env";
import { type NextRequest, NextResponse } from "next/server";

function contentTypeEssence(header: string): string {
	const essence = header.split(";")[0]?.trim().toLowerCase() ?? "";
	return essence;
}

function denial(status: 403 | 415, error: string) {
	return NextResponse.json({ error }, { status });
}

export function revisionRouteDenial(request: NextRequest): NextResponse | null {
	const contentType = request.headers.get("content-type") ?? "";
	if (contentTypeEssence(contentType) !== "application/json") {
		return denial(415, "JSON content type required");
	}
	const origin = request.headers.get("origin");
	if (!origin || origin === "null") {
		return denial(403, "Cross-origin request rejected");
	}
	let originUrl: URL;
	try {
		originUrl = new URL(origin);
	} catch {
		return denial(403, "Cross-origin request rejected");
	}
	let canonical: URL;
	try {
		canonical = new URL(serverEnv().WEB_URL);
	} catch {
		return denial(403, "Cross-origin request rejected");
	}
	const site = request.headers.get("sec-fetch-site");
	if (site && site.toLowerCase() !== "same-origin") {
		return denial(403, "Cross-origin request rejected");
	}
	if (
		originUrl.protocol !== canonical.protocol ||
		originUrl.hostname !== canonical.hostname ||
		explicitPort(originUrl) !== explicitPort(canonical)
	) {
		return denial(403, "Cross-origin request rejected");
	}
	return null;
}

function explicitPort(url: URL) {
	if (url.port) return url.port;
	if (url.protocol === "https:") return "443";
	if (url.protocol === "http:") return "80";
	return "";
}

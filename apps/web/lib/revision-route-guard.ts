import { type NextRequest, NextResponse } from "next/server";

// nginx forwards Host. `next start` request.url is the bind address, not the page origin.
export function revisionRouteDenial(request: NextRequest): NextResponse | null {
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("application/json")) {
		return NextResponse.json(
			{ error: "JSON content type required" },
			{ status: 415 },
		);
	}
	const origin = request.headers.get("origin");
	const forwarded = request.headers
		.get("x-forwarded-host")
		?.split(",")[0]
		?.trim();
	const host = forwarded || request.headers.get("host");
	if (!origin || !host) {
		return NextResponse.json(
			{ error: "Cross-origin request rejected" },
			{ status: 403 },
		);
	}
	let originHost: string;
	try {
		originHost = new URL(origin).host;
	} catch {
		return NextResponse.json(
			{ error: "Cross-origin request rejected" },
			{ status: 403 },
		);
	}
	if (originHost !== host) {
		return NextResponse.json(
			{ error: "Cross-origin request rejected" },
			{ status: 403 },
		);
	}
	return null;
}

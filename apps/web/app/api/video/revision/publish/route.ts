import { type NextRequest, NextResponse } from "next/server";
import { RevisionPublicationError } from "@/lib/revision-publication";
import {
	parseRevisionRouteBody,
	publishOwnerRevision,
} from "@/lib/revision-publish";
import {
	isAbortLike,
	summarizeRevisionError,
} from "@/lib/revision-request-error";
import { revisionRouteDenial } from "@/lib/revision-route-guard";

export const dynamic = "force-dynamic";

function revisionRouteError(error: unknown) {
	if (error instanceof RevisionPublicationError) {
		return NextResponse.json(
			{ error: error.message },
			{ status: error.status },
		);
	}
	console.error("[revision/publish]", summarizeRevisionError(error));
	if (isAbortLike(error)) {
		return NextResponse.json({ error: "Prepare aborted" }, { status: 499 });
	}
	return NextResponse.json(
		{ error: "Revision request failed" },
		{ status: 500 },
	);
}

export async function POST(request: NextRequest) {
	const denied = revisionRouteDenial(request);
	if (denied) return denied;
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
	}
	const input = parseRevisionRouteBody(body);
	if (!input) {
		return NextResponse.json(
			{ error: "Invalid revision request" },
			{ status: 400 },
		);
	}
	try {
		const published = await publishOwnerRevision(input, request.headers);
		return NextResponse.json(published);
	} catch (error) {
		return revisionRouteError(error);
	}
}

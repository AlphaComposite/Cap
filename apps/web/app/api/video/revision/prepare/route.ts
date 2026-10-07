import { type NextRequest, NextResponse } from "next/server";
import { failUnjoinedInflightPrepare } from "@/lib/revision-prepare-abort";
import { RevisionPublicationError } from "@/lib/revision-publication";
import {
	parseRevisionRouteBody,
	prepareOwnerRevision,
} from "@/lib/revision-publish";
import { revisionRouteDenial } from "@/lib/revision-route-guard";

export const dynamic = "force-dynamic";

function revisionRouteError(error: unknown) {
	if (error instanceof RevisionPublicationError) {
		return NextResponse.json(
			{ error: error.message },
			{ status: error.status },
		);
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
	const originAbort = new AbortController();
	const prepared = prepareOwnerRevision(input, { signal: originAbort.signal });
	const aborted = new Promise<"aborted">((resolve) => {
		if (request.signal.aborted) {
			resolve("aborted");
			return;
		}
		request.signal.addEventListener("abort", () => resolve("aborted"), {
			once: true,
		});
	});
	try {
		const winner = await Promise.race([
			prepared.then((value) => ({ kind: "prepared" as const, value })),
			aborted.then(() => ({ kind: "aborted" as const })),
		]);
		if (winner.kind === "aborted" || request.signal.aborted) {
			const decision = await failUnjoinedInflightPrepare({
				videoId: input.videoId,
			});
			if (!decision.joined) originAbort.abort();
			if (decision.markedFailed) {
				return NextResponse.json({ error: "Prepare aborted" }, { status: 499 });
			}
			const value = winner.kind === "prepared" ? winner.value : await prepared;
			if (!decision.joined) {
				const after = await failUnjoinedInflightPrepare({
					videoId: input.videoId,
					revisionId: value.revisionId,
				});
				if (after.markedFailed) {
					return NextResponse.json(
						{ error: "Prepare aborted" },
						{ status: 499 },
					);
				}
			}
			return NextResponse.json({
				revisionId: value.revisionId,
				generation: value.generation,
			});
		}
		return NextResponse.json({
			revisionId: winner.value.revisionId,
			generation: winner.value.generation,
		});
	} catch (error) {
		if (error instanceof RevisionPublicationError && error.status === 409) {
			console.warn("[revision/prepare] conflict", {
				videoId: input.videoId,
				message: error.message,
			});
		}
		if (request.signal.aborted) {
			const decision = await failUnjoinedInflightPrepare({
				videoId: input.videoId,
			});
			if (!decision.joined) originAbort.abort();
			if (decision.markedFailed) {
				return NextResponse.json({ error: "Prepare aborted" }, { status: 499 });
			}
		}
		return revisionRouteError(error);
	}
}

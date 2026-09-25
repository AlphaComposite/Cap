import { Video } from "@cap/web-domain";
import { type NextRequest, NextResponse } from "next/server";
import { mintRevisionMediaGrant } from "@/lib/revision-media-grant";
import {
	REVISION_MEDIA_CACHE_CONTROL,
	REVISION_MEDIA_REFERRER_POLICY,
} from "@/lib/revision-media-token";

export const dynamic = "force-dynamic";

const headers = {
	"Cache-Control": REVISION_MEDIA_CACHE_CONTROL,
	"Referrer-Policy": REVISION_MEDIA_REFERRER_POLICY,
};

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;

export async function POST(request: NextRequest) {
	let rawVideoId = "";
	let requestedRevisionId: string | null = null;
	try {
		const body = (await request.json()) as {
			videoId?: unknown;
			revisionId?: unknown;
		};
		if (typeof body.videoId === "string") rawVideoId = body.videoId;
		if (typeof body.revisionId === "string")
			requestedRevisionId = body.revisionId;
	} catch {
		return NextResponse.json(
			{ error: "missing_video" },
			{ status: 400, headers },
		);
	}
	if (!idPattern.test(rawVideoId)) {
		return NextResponse.json(
			{ error: "missing_video" },
			{ status: 400, headers },
		);
	}
	const origin = new URL(request.url).origin;
	try {
		const minted = await mintRevisionMediaGrant(
			null,
			Video.VideoId.make(rawVideoId),
			{ origin },
		);
		if (!minted.enabled) {
			return NextResponse.json({ enabled: false }, { status: 204, headers });
		}
		if (!minted.ok) {
			return NextResponse.json(
				{ error: minted.reason },
				{ status: minted.status, headers },
			);
		}
		return NextResponse.json(
			{
				enabled: true,
				videoId: minted.videoId,
				revisionId: minted.revisionId,
				changed:
					requestedRevisionId !== null &&
					requestedRevisionId !== minted.revisionId,
				grant: minted.grant,
				publicationEpoch: minted.publicationEpoch,
				policyEpoch: minted.policyEpoch,
				expiresAt: minted.expiresAt,
			},
			{ status: 200, headers },
		);
	} catch {
		return NextResponse.json(
			{ error: "grant_failed" },
			{ status: 503, headers },
		);
	}
}

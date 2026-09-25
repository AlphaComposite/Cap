// CONTRACT STUB (owned by W-D)
// Origin verifies this exact encoding. Replace this file; do not rename the exports.

import { createHmac, timingSafeEqual } from "node:crypto";

export const REVISION_MEDIA_GRANT_TTL_SECONDS = 60;
export const REVISION_MEDIA_GRANT_SKEW_SECONDS = 5;

export type RevisionMediaGrantClaims = {
	v: 1;
	videoId: string;
	revisionId: string;
	publicationEpoch: number;
	policyEpoch: number;
	iat: number;
	exp: number;
	grantId: string;
};

const claimKeys = [
	"exp",
	"grantId",
	"iat",
	"policyEpoch",
	"publicationEpoch",
	"revisionId",
	"v",
	"videoId",
] as const;

export function canonicalRevisionMediaGrantJson(
	claims: RevisionMediaGrantClaims,
): string {
	const ordered = {
		exp: claims.exp,
		grantId: claims.grantId,
		iat: claims.iat,
		policyEpoch: claims.policyEpoch,
		publicationEpoch: claims.publicationEpoch,
		revisionId: claims.revisionId,
		v: claims.v,
		videoId: claims.videoId,
	};
	return JSON.stringify(ordered);
}

function b64url(data: Buffer): string {
	return data.toString("base64url");
}

export function mintRevisionMediaToken(
	secret: string,
	claims: RevisionMediaGrantClaims,
): string {
	if (
		claims.v !== 1 ||
		claims.exp - claims.iat !== REVISION_MEDIA_GRANT_TTL_SECONDS
	) {
		throw new Error("revision media grant claims rejected");
	}
	const payload = Buffer.from(canonicalRevisionMediaGrantJson(claims), "utf8");
	const sig = createHmac("sha256", secret).update(payload).digest();
	return `${b64url(payload)}.${b64url(sig)}`;
}

export function verifyRevisionMediaToken(
	secret: string,
	token: string,
	now: number,
): RevisionMediaGrantClaims {
	const [left, right] = token.split(".");
	if (!left || !right || token.split(".").length !== 2) {
		throw new Error("unauthorized");
	}
	const payload = Buffer.from(left, "base64url");
	const sig = Buffer.from(right, "base64url");
	const expected = createHmac("sha256", secret).update(payload).digest();
	const presented = sig.length === expected.length ? sig : expected;
	if (!timingSafeEqual(expected, presented) || sig.length !== expected.length) {
		throw new Error("unauthorized");
	}
	const claims = JSON.parse(
		payload.toString("utf8"),
	) as RevisionMediaGrantClaims;
	if (canonicalRevisionMediaGrantJson(claims) !== payload.toString("utf8")) {
		throw new Error("unauthorized");
	}
	if (
		Object.keys(claims).sort().join(",") !== [...claimKeys].sort().join(",")
	) {
		throw new Error("unauthorized");
	}
	if (claims.exp - claims.iat !== REVISION_MEDIA_GRANT_TTL_SECONDS) {
		throw new Error("unauthorized");
	}
	if (
		claims.iat > now + REVISION_MEDIA_GRANT_SKEW_SECONDS ||
		now >= claims.exp
	) {
		throw new Error("unauthorized");
	}
	return claims;
}

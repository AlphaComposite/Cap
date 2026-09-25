// CONTRACT STUB (owned by W-D)
// Integrator replaces signing and verification. Do not log claims or tokens.

export const REVISION_MEDIA_TOKEN_VERSION = 1 as const;

export type RevisionMediaTokenClaims = {
	v: typeof REVISION_MEDIA_TOKEN_VERSION;
	videoId: string;
	revisionId: string;
	publicationEpoch: number;
	policyEpoch: number;
	iat: number;
	exp: number;
	grantId: string;
};

export function revisionMediaTokenTtlSeconds(): number {
	return 60;
}

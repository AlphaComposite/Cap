import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const REVISION_MEDIA_GRANT_TTL_SECONDS = 60;
export const REVISION_MEDIA_GRANT_SKEW_SECONDS = 5;
export const REVISION_MEDIA_GRANT_VERSION = 1 as const;

export const REVISION_MEDIA_CACHE_CONTROL = "private, no-store";
export const REVISION_MEDIA_REFERRER_POLICY = "no-referrer";

const GRANT_KEY_DOMAIN = "cap-revision-media-grant-v1";
const SERVICE_KEY_DOMAIN = "cap-revision-origin-service-v1";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const GRANT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type RevisionMediaGrantPayload = {
	v: 1;
	videoId: string;
	revisionId: string;
	publicationEpoch: number;
	policyEpoch: number;
	iat: number;
	exp: number;
	grantId: string;
};

export type GrantDenial =
	| "malformed"
	| "forged"
	| "expired"
	| "skew"
	| "unauthorized"
	| "stale_publication"
	| "stale_policy"
	| "deleted"
	| "private"
	| "non_current";

export type GrantKey = {
	id: string;
	secret: string;
};

export function grantDenialStatus(denial: GrantDenial): 401 | 403 | 410 {
	if (
		denial === "malformed" ||
		denial === "forged" ||
		denial === "expired" ||
		denial === "skew"
	) {
		return 401;
	}
	if (denial === "unauthorized") return 403;
	return 410;
}

export function canonicalGrantJson(payload: RevisionMediaGrantPayload): string {
	return `{"v":1,"videoId":${JSON.stringify(payload.videoId)},"revisionId":${JSON.stringify(payload.revisionId)},"publicationEpoch":${payload.publicationEpoch},"policyEpoch":${payload.policyEpoch},"iat":${payload.iat},"exp":${payload.exp},"grantId":${JSON.stringify(payload.grantId)}}`;
}

const isSafeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const parseKeyRing = (raw: string | undefined): GrantKey[] => {
	if (!raw?.trim()) return [];
	const keys: GrantKey[] = [];
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const splitAt = trimmed.indexOf(":");
		if (splitAt <= 0 || splitAt === trimmed.length - 1) continue;
		keys.push({
			id: trimmed.slice(0, splitAt),
			secret: trimmed.slice(splitAt + 1),
		});
	}
	return keys;
};

const derivedSecret = (root: string, domain: string) =>
	createHmac("sha256", root).update(domain).digest("base64url");

export function resolveGrantKeys(
	env: NodeJS.ProcessEnv = process.env,
): GrantKey[] {
	const configured = parseKeyRing(env.REVISION_MEDIA_GRANT_KEYS);
	if (configured.length > 0) return configured;
	const root = env.NEXTAUTH_SECRET;
	if (!root) return [];
	return [{ id: "derived", secret: derivedSecret(root, GRANT_KEY_DOMAIN) }];
}

export function resolveServiceSecret(
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const dedicated = env.REVISION_ORIGIN_SERVICE_SECRET;
	if (dedicated && dedicated.length > 0) return dedicated;
	const root = env.NEXTAUTH_SECRET;
	if (!root) return null;
	return derivedSecret(root, SERVICE_KEY_DOMAIN);
}

const hmac = (secret: string, payload: string) =>
	createHmac("sha256", secret).update(payload).digest("base64url");

const constantTimeEqual = (left: string, right: string) => {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	if (leftBuffer.length !== rightBuffer.length) {
		timingSafeEqual(leftBuffer, leftBuffer);
		return false;
	}
	return timingSafeEqual(leftBuffer, rightBuffer);
};

const signatureMatches = (
	payload: string,
	signature: string,
	keys: GrantKey[],
) => {
	let matched = 0;
	for (const key of keys) {
		matched |= constantTimeEqual(signature, hmac(key.secret, payload)) ? 1 : 0;
	}
	return matched === 1;
};

const isGrantPayload = (value: unknown): value is RevisionMediaGrantPayload => {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.v === 1 &&
		typeof record.videoId === "string" &&
		ID_PATTERN.test(record.videoId) &&
		typeof record.revisionId === "string" &&
		ID_PATTERN.test(record.revisionId) &&
		isSafeInteger(record.publicationEpoch) &&
		isSafeInteger(record.policyEpoch) &&
		isSafeInteger(record.iat) &&
		isSafeInteger(record.exp) &&
		typeof record.grantId === "string" &&
		GRANT_ID_PATTERN.test(record.grantId) &&
		Object.keys(record).length === 8
	);
};

export function signRevisionMediaGrant(
	input: Omit<RevisionMediaGrantPayload, "v" | "iat" | "exp" | "grantId"> & {
		grantId?: string;
		now?: number;
	},
	env: NodeJS.ProcessEnv = process.env,
): string {
	const keys = resolveGrantKeys(env);
	const secret = keys[0]?.secret;
	if (!secret) throw new Error("revision media grant key is not configured");
	const iat = input.now ?? Math.floor(Date.now() / 1000);
	const payload: RevisionMediaGrantPayload = {
		v: 1,
		videoId: input.videoId,
		revisionId: input.revisionId,
		publicationEpoch: input.publicationEpoch,
		policyEpoch: input.policyEpoch,
		iat,
		exp: iat + REVISION_MEDIA_GRANT_TTL_SECONDS,
		grantId: input.grantId ?? randomBytes(16).toString("base64url"),
	};
	const encoded = Buffer.from(canonicalGrantJson(payload), "utf8").toString(
		"base64url",
	);
	return `${encoded}.${hmac(secret, encoded)}`;
}

export type VerifiedGrant =
	| { ok: true; payload: RevisionMediaGrantPayload }
	| { ok: false; denial: GrantDenial };

export function verifyRevisionMediaGrant(
	token: string,
	options: {
		now?: number;
		skewSeconds?: number;
		env?: NodeJS.ProcessEnv;
	} = {},
): VerifiedGrant {
	const parts = token.split(".");
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		return { ok: false, denial: "malformed" };
	}
	const [encoded, signature] = parts;
	const keys = resolveGrantKeys(options.env);
	if (!signatureMatches(encoded, signature, keys)) {
		return { ok: false, denial: "forged" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch {
		return { ok: false, denial: "malformed" };
	}
	if (!isGrantPayload(parsed)) return { ok: false, denial: "malformed" };
	const canonical = Buffer.from(canonicalGrantJson(parsed), "utf8").toString(
		"base64url",
	);
	if (!constantTimeEqual(encoded, canonical)) {
		return { ok: false, denial: "malformed" };
	}
	if (parsed.exp - parsed.iat !== REVISION_MEDIA_GRANT_TTL_SECONDS) {
		return { ok: false, denial: "malformed" };
	}
	const now = options.now ?? Math.floor(Date.now() / 1000);
	const skew = options.skewSeconds ?? REVISION_MEDIA_GRANT_SKEW_SECONDS;
	if (parsed.iat > now + skew) return { ok: false, denial: "skew" };
	if (now > parsed.exp + skew) return { ok: false, denial: "expired" };
	return { ok: true, payload: parsed };
}

export type LiveGrantState = {
	videoId: string;
	revisionId: string;
	publicationEpoch: number;
	policyEpoch: number;
	currentRevisionId: string | null;
	deleted: boolean;
	privateOrUnauthorized: boolean;
};

export function evaluatePresentedGrant(
	verified: VerifiedGrant,
	live: LiveGrantState,
):
	| { ok: true; payload: RevisionMediaGrantPayload }
	| { ok: false; denial: GrantDenial; status: 401 | 403 | 410 } {
	if (!verified.ok) {
		const denial = verified.denial;
		return { ok: false, denial, status: grantDenialStatus(denial) };
	}
	const payload = verified.payload;
	if (
		payload.videoId !== live.videoId ||
		payload.revisionId !== live.revisionId
	) {
		return { ok: false, denial: "unauthorized", status: 403 };
	}
	if (live.deleted) return { ok: false, denial: "deleted", status: 410 };
	if (live.privateOrUnauthorized) {
		return { ok: false, denial: "private", status: 410 };
	}
	if (payload.policyEpoch !== live.policyEpoch) {
		return { ok: false, denial: "stale_policy", status: 410 };
	}
	if (
		payload.publicationEpoch !== live.publicationEpoch ||
		live.currentRevisionId !== payload.revisionId
	) {
		return { ok: false, denial: "stale_publication", status: 410 };
	}
	return { ok: true, payload };
}

export function redactGrantBearer(value: string): string {
	return value
		.replace(/([?&]t=)[^&\s]+/g, "$1[redacted]")
		.replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g, "[redacted-grant]");
}

export type InternalServiceClaims = {
	v: 1;
	aud: "origin-service";
	iat: number;
	exp: number;
	nonce: string;
};

export function signInternalServiceRequest(
	input: { method: string; path: string; now?: number },
	env: NodeJS.ProcessEnv = process.env,
): string {
	const secret = resolveServiceSecret(env);
	if (!secret) throw new Error("origin service secret is not configured");
	const iat = input.now ?? Math.floor(Date.now() / 1000);
	const claims: InternalServiceClaims = {
		v: 1,
		aud: "origin-service",
		iat,
		exp: iat + 30,
		nonce: randomBytes(12).toString("base64url"),
	};
	const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString(
		"base64url",
	);
	const mac = hmac(
		secret,
		`${encoded}.${input.method.toUpperCase()}.${input.path}`,
	);
	return `${encoded}.${mac}`;
}

export function verifyInternalServiceRequest(
	token: string,
	input: { method: string; path: string; now?: number },
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const secret = resolveServiceSecret(env);
	const parts = token.split(".");
	if (!secret || parts.length !== 2 || !parts[0] || !parts[1]) return false;
	const expected = hmac(
		secret,
		`${parts[0]}.${input.method.toUpperCase()}.${input.path}`,
	);
	if (!constantTimeEqual(parts[1], expected)) return false;
	let claims: InternalServiceClaims;
	try {
		claims = JSON.parse(
			Buffer.from(parts[0], "base64url").toString("utf8"),
		) as InternalServiceClaims;
	} catch {
		return false;
	}
	if (claims.aud !== "origin-service" || claims.v !== 1) return false;
	const now = input.now ?? Math.floor(Date.now() / 1000);
	return (
		claims.iat <= now + REVISION_MEDIA_GRANT_SKEW_SECONDS && now <= claims.exp
	);
}

export function getRevisionPlaybackUrl(input: {
	videoId: string;
	revisionId: string;
	grant: string;
	origin?: string;
	child?: string;
}): string {
	const child = input.child ?? "playlist.m3u8";
	const path = `/media/${input.videoId}/r/${input.revisionId}/${child}?t=${encodeURIComponent(input.grant)}`;
	if (!input.origin) return path;
	return new URL(path, input.origin).toString();
}

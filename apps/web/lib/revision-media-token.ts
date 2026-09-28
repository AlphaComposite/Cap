import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";

export const REVISION_MEDIA_GRANT_TTL_SECONDS = 60;
export const REVISION_MEDIA_GRANT_SKEW_SECONDS = 5;
export const REVISION_MEDIA_GRANT_VERSION = 1 as const;

export const REVISION_MEDIA_CACHE_CONTROL = "private, no-store";
export const REVISION_MEDIA_REFERRER_POLICY = "no-referrer";

export const ORIGIN_SERVICE_HEADER = "x-cap-origin-service";
export const ORIGIN_ATTESTATION_HEADER = "x-cap-origin-attestation";
export const ORIGIN_SERVICE_TTL_SECONDS = 30;
const MIN_SECRET_BYTES = 32;
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

const usableSecret = (secret: string) => secret.length >= MIN_SECRET_BYTES;

export function resolveGrantKeys(
	env: NodeJS.ProcessEnv = process.env,
): GrantKey[] {
	return parseKeyRing(env.REVISION_MEDIA_GRANT_KEYS).filter((key) =>
		usableSecret(key.secret),
	);
}

export function resolveServiceSecret(
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const dedicated = env.REVISION_ORIGIN_SERVICE_SECRET;
	if (!dedicated || !usableSecret(dedicated)) return null;
	return dedicated;
}

export function originBodySha256(body: string | Uint8Array = ""): string {
	return createHash("sha256").update(body).digest("hex");
}

const hmac = (secret: string, payload: string | Uint8Array) =>
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
	const key = keys[0];
	if (!key) throw new Error("revision media grant key is not configured");
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
	return `${key.id}.${encoded}.${hmac(key.secret, encoded)}`;
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
	if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
		return { ok: false, denial: "malformed" };
	}
	const [kid, encoded, signature] = parts;
	const keys = resolveGrantKeys(options.env).filter((key) => key.id === kid);
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
	input: {
		method: string;
		path: string;
		body?: string | Uint8Array;
		now?: number;
	},
	env: NodeJS.ProcessEnv = process.env,
): string {
	const secret = resolveServiceSecret(env);
	if (!secret) throw new Error("origin service secret is not configured");
	const iat = input.now ?? Math.floor(Date.now() / 1000);
	const claims: InternalServiceClaims = {
		v: 1,
		aud: "origin-service",
		iat,
		exp: iat + ORIGIN_SERVICE_TTL_SECONDS,
		nonce: randomBytes(12).toString("base64url"),
	};
	const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString(
		"base64url",
	);
	const mac = hmac(
		secret,
		`${encoded}.${input.method.toUpperCase()}.${input.path}.${originBodySha256(input.body ?? "")}`,
	);
	return `${encoded}.${mac}`;
}

export function verifyInternalServiceRequest(
	token: string,
	input: {
		method: string;
		path: string;
		body?: string | Uint8Array;
		now?: number;
	},
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const secret = resolveServiceSecret(env);
	const parts = token.split(".");
	if (!secret || parts.length !== 2 || !parts[0] || !parts[1]) return false;
	const expected = hmac(
		secret,
		`${parts[0]}.${input.method.toUpperCase()}.${input.path}.${originBodySha256(input.body ?? "")}`,
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
	if (
		!Number.isSafeInteger(claims.iat) ||
		!Number.isSafeInteger(claims.exp) ||
		claims.exp - claims.iat !== ORIGIN_SERVICE_TTL_SECONDS
	) {
		return false;
	}
	const now = input.now ?? Math.floor(Date.now() / 1000);
	return (
		claims.iat <= now + REVISION_MEDIA_GRANT_SKEW_SECONDS && now <= claims.exp
	);
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;

export const ATTESTATION_VERSION = 2;

export type RangeSnap = {
	firstPts: number;
	lastPts: number;
	lastDur: number;
};

export type OriginAttestation = {
	attestationVersion: 2;
	decodedFrames: number;
	durationSeconds: number;
	durationTicks: number;
	initSha256: string;
	intentId: string;
	maxHoldTicks: number;
	playlistDurationSeconds: number;
	playlistHasEndList: true;
	rangeSnaps: RangeSnap[];
	seg0DecodedFrames: number;
	seg0Sha256: string;
	/** Optional; end of the source's final video frame (cap-fzp.8.7.36). */
	sourceEndTicks?: number;
	timescale: number;
};

export function signOriginAttestation(
	body: string | Uint8Array,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const secret = resolveServiceSecret(env);
	if (!secret) throw new Error("origin service secret is not configured");
	const payload = typeof body === "string" ? body : Buffer.from(body);
	return hmac(secret, payload);
}

export function verifyOriginAttestation(
	mac: string,
	body: string | Uint8Array,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const secret = resolveServiceSecret(env);
	if (!secret || mac.length === 0) return false;
	try {
		const payload = typeof body === "string" ? body : Buffer.from(body);
		return constantTimeEqual(mac, hmac(secret, payload));
	} catch {
		return false;
	}
}

function attestationHash(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX.test(value);
}

function readRangeSnaps(value: unknown): RangeSnap[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const snaps: RangeSnap[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) return null;
		const row = item as Record<string, unknown>;
		if (
			!Number.isSafeInteger(row.firstPts) ||
			!Number.isSafeInteger(row.lastPts) ||
			!Number.isSafeInteger(row.lastDur) ||
			(row.firstPts as number) < 0 ||
			(row.lastPts as number) < (row.firstPts as number) ||
			(row.lastDur as number) <= 0
		) {
			return null;
		}
		snaps.push({
			firstPts: row.firstPts as number,
			lastPts: row.lastPts as number,
			lastDur: row.lastDur as number,
		});
	}
	return snaps;
}

export type AttestationRejectReason = "mac" | "version" | "shape";

export function classifyOriginAttestation(
	mac: string,
	body: string,
	env: NodeJS.ProcessEnv = process.env,
):
	| { ok: true; attestation: OriginAttestation }
	| { ok: false; reason: AttestationRejectReason } {
	if (!verifyOriginAttestation(mac, body, env)) {
		return { ok: false, reason: "mac" };
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(body) as Record<string, unknown>;
	} catch {
		return { ok: false, reason: "shape" };
	}
	if (parsed.attestationVersion !== ATTESTATION_VERSION) {
		return { ok: false, reason: "version" };
	}
	const attestation = parseVerifiedOriginAttestation(mac, body, env);
	if (!attestation) return { ok: false, reason: "shape" };
	return { ok: true, attestation };
}

export function parseVerifiedOriginAttestation(
	mac: string,
	body: string,
	env: NodeJS.ProcessEnv = process.env,
): OriginAttestation | null {
	if (!verifyOriginAttestation(mac, body, env)) return null;
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		const decodedFrames = parsed.decodedFrames;
		const seg0DecodedFrames = parsed.seg0DecodedFrames;
		const durationSeconds = parsed.durationSeconds;
		const playlistDurationSeconds = parsed.playlistDurationSeconds;
		const durationTicks = parsed.durationTicks;
		const timescale = parsed.timescale;
		const maxHoldTicks = parsed.maxHoldTicks;
		const rangeSnaps = readRangeSnaps(parsed.rangeSnaps);
		if (
			parsed.attestationVersion !== ATTESTATION_VERSION ||
			parsed.playlistHasEndList !== true ||
			typeof parsed.intentId !== "string" ||
			parsed.intentId.length === 0 ||
			!Number.isSafeInteger(decodedFrames) ||
			(decodedFrames as number) < 1 ||
			!Number.isSafeInteger(seg0DecodedFrames) ||
			(seg0DecodedFrames as number) < 1 ||
			typeof durationSeconds !== "number" ||
			!Number.isFinite(durationSeconds) ||
			typeof playlistDurationSeconds !== "number" ||
			!Number.isFinite(playlistDurationSeconds) ||
			!Number.isSafeInteger(durationTicks) ||
			(durationTicks as number) <= 0 ||
			!Number.isSafeInteger(timescale) ||
			(timescale as number) <= 0 ||
			!Number.isSafeInteger(maxHoldTicks) ||
			(maxHoldTicks as number) <= 0 ||
			!rangeSnaps ||
			!attestationHash(parsed.initSha256) ||
			!attestationHash(parsed.seg0Sha256) ||
			(parsed.thumbnailSha256 !== undefined &&
				parsed.thumbnailSha256 !== "pending" &&
				!attestationHash(parsed.thumbnailSha256))
		) {
			return null;
		}
		return {
			attestationVersion: ATTESTATION_VERSION,
			decodedFrames: decodedFrames as number,
			durationSeconds,
			durationTicks: durationTicks as number,
			initSha256: parsed.initSha256,
			intentId: parsed.intentId,
			maxHoldTicks: maxHoldTicks as number,
			playlistDurationSeconds,
			playlistHasEndList: true,
			rangeSnaps,
			seg0DecodedFrames: seg0DecodedFrames as number,
			seg0Sha256: parsed.seg0Sha256,
			...(Number.isSafeInteger(parsed.sourceEndTicks) &&
			(parsed.sourceEndTicks as number) > 0
				? { sourceEndTicks: parsed.sourceEndTicks as number }
				: {}),
			timescale: timescale as number,
		};
	} catch {
		return null;
	}
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

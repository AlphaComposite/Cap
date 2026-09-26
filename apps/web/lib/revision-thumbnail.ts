import { createHash } from "node:crypto";

const NEUTRAL_PREVIEW_JPEG = Buffer.from(
	"ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda00080001000100003f00fbffd9",
	"hex",
);

export function neutralPreviewJpeg(): Buffer {
	return Buffer.from(NEUTRAL_PREVIEW_JPEG);
}

export function isPendingThumbnailMarker(body: Buffer): boolean {
	return (
		body.length === 4 &&
		body[0] === 0xff &&
		body[1] === 0xd8 &&
		body[2] === 0xff &&
		body[3] === 0xd9
	);
}

export function isVerifiedJpeg(body: Buffer): boolean {
	if (body.length <= 4 || isPendingThumbnailMarker(body)) return false;
	if (body[0] !== 0xff || body[1] !== 0xd8) return false;
	if (body[body.length - 2] !== 0xff || body[body.length - 1] !== 0xd9) {
		return false;
	}
	return (
		body.includes(Buffer.from([0xff, 0xc0])) ||
		body.includes(Buffer.from([0xff, 0xc2]))
	);
}

export function thumbnailSha256(body: Buffer): string {
	return createHash("sha256").update(body).digest("hex");
}

export type PreviewThumbnailChoice = {
	body: Buffer;
	kind: "current" | "previous" | "placeholder";
};

export function selectPreviewThumbnail(input: {
	currentState: string | null;
	currentBody?: Buffer | null;
	currentSha256?: string | null;
	previousState?: string | null;
	previousBody?: Buffer | null;
	previousSha256?: string | null;
}): PreviewThumbnailChoice {
	const current = verifiedChainThumbnail(
		input.currentState,
		input.currentBody,
		input.currentSha256,
	);
	if (current) return { body: current, kind: "current" };
	const previous = verifiedChainThumbnail(
		input.previousState,
		input.previousBody,
		input.previousSha256,
	);
	if (previous) return { body: previous, kind: "previous" };
	return { body: neutralPreviewJpeg(), kind: "placeholder" };
}

function verifiedChainThumbnail(
	state: string | null | undefined,
	body: Buffer | null | undefined,
	sha256: string | null | undefined,
): Buffer | null {
	if (state !== "READY" || !body || !sha256) return null;
	if (!isVerifiedJpeg(body)) return null;
	if (thumbnailSha256(body) !== sha256) return null;
	return body;
}

export function thumbnailRetryDelayMs(attempts: number): number {
	const step = Math.max(0, attempts - 1);
	return Math.min(30_000, 500 * 2 ** step);
}

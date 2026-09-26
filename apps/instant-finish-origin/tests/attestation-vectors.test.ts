import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

type AttestationVector = {
	header: string;
	serviceSecret: string;
	body: string;
	mac: string;
};

const vectors = JSON.parse(
	readFileSync(new URL("./vectors/attestation.json", import.meta.url), "utf8"),
) as AttestationVector;

function attestationMac(secret: string, body: string): string {
	return createHmac("sha256", secret).update(body).digest("base64url");
}

describe("shared origin attestation vector", () => {
	test("header and mac match the python signer", () => {
		expect(vectors.header).toBe("x-cap-origin-attestation");
		expect(attestationMac(vectors.serviceSecret, vectors.body)).toBe(
			vectors.mac,
		);
	});

	test("a flipped body does not verify", () => {
		const flipped = `x${vectors.body.slice(1)}`;
		expect(attestationMac(vectors.serviceSecret, flipped)).not.toBe(
			vectors.mac,
		);
	});
});

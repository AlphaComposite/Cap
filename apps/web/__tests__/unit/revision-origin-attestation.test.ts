import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	parseVerifiedOriginAttestation,
	signOriginAttestation,
	verifyOriginAttestation,
} from "@/lib/revision-media-token";

const vector = JSON.parse(
	readFileSync(
		new URL(
			"../../../instant-finish-origin/tests/vectors/attestation.json",
			import.meta.url,
		),
		"utf8",
	),
) as {
	header: string;
	body: string;
	mac: string;
	serviceSecret: string;
};

const env = {
	...process.env,
	REVISION_ORIGIN_SERVICE_SECRET: vector.serviceSecret,
};

describe("origin prepare attestation", () => {
	it("MACs the raw prepare body and rejects a re-serialized or forged body", () => {
		expect(vector.header).toBe("x-cap-origin-attestation");
		expect(vector.body.endsWith("\n")).toBe(true);
		const parsed = JSON.parse(vector.body) as Record<string, unknown>;
		const recanonical = `{${Object.keys(parsed)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}: ${JSON.stringify(parsed[key]).replaceAll(",", ", ").replaceAll(":", ": ")}`,
			)
			.join(", ")}}\n`;
		expect(recanonical).toBe(vector.body);
		expect(signOriginAttestation(vector.body, env)).toBe(vector.mac);
		expect(verifyOriginAttestation(vector.mac, vector.body, env)).toBe(true);
		expect(
			verifyOriginAttestation(vector.mac, `${JSON.stringify(parsed)}\n`, env),
		).toBe(false);
		expect(
			parseVerifiedOriginAttestation(vector.mac, vector.body, env)?.intentId,
		).toBe("intent-vector-01");
		const old = `${vector.body.trimEnd().slice(0, -1)},"attestationVersion":1}\n`;
		expect(
			parseVerifiedOriginAttestation(signOriginAttestation(old, env), old, env),
		).toBeNull();
		expect(verifyOriginAttestation(vector.mac, vector.body.trim(), env)).toBe(
			false,
		);
		expect(
			parseVerifiedOriginAttestation(vector.mac, vector.body.trim(), env),
		).toBeNull();
		expect(verifyOriginAttestation("forged", vector.body, env)).toBe(false);
		expect(vector.mac).not.toContain(vector.serviceSecret);
	});
});

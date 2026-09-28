import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	classifyOriginAttestation,
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
		// cap-fzp.8.7.36: signed sourceEndTicks is read; absent stays absent.
		expect(
			parseVerifiedOriginAttestation(vector.mac, vector.body, env)
				?.sourceEndTicks,
		).toBeUndefined();
		const withEnd = vector.body.replace(
			'"segmentCount": 2,',
			'"segmentCount": 2, "sourceEndTicks": 23040,',
		);
		expect(withEnd).not.toBe(vector.body);
		expect(
			parseVerifiedOriginAttestation(
				signOriginAttestation(withEnd, env),
				withEnd,
				env,
			)?.sourceEndTicks,
		).toBe(23040);
		expect(vector.mac).not.toContain(vector.serviceSecret);
		const v1 = vector.body.replace(
			'"attestationVersion": 2',
			'"attestationVersion": 1',
		);
		expect(v1).not.toBe(vector.body);
		expect(
			classifyOriginAttestation(signOriginAttestation(v1, env), v1, env),
		).toEqual({ ok: false, reason: "version" });
	});
});

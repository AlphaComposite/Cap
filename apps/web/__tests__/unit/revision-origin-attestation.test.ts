import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	parseVerifiedOriginAttestation,
	signOriginAttestation,
	verifyOriginAttestation,
} from "@/lib/revision-media-token";

const vector = JSON.parse(
	readFileSync(
		new URL("./fixtures/origin-attestation.json", import.meta.url),
		"utf8",
	),
) as {
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
		expect(vector.body.endsWith("\n")).toBe(true);
		expect(signOriginAttestation(vector.body, env)).toBe(vector.mac);
		expect(verifyOriginAttestation(vector.mac, vector.body, env)).toBe(true);
		expect(
			parseVerifiedOriginAttestation(vector.mac, vector.body, env),
		).toBeNull();
		const fenced = `${vector.body.trimEnd().slice(0, -1)},"playlistDurationSeconds":1.5,"seg0DecodedFrames":4}\n`;
		const fencedMac = signOriginAttestation(fenced, env);
		const parsed = parseVerifiedOriginAttestation(fencedMac, fenced, env);
		expect(parsed?.intentId).toBe("intent-vector-01");
		expect(parsed?.decodedFrames).toBe(4);
		expect(parsed?.seg0DecodedFrames).toBe(4);
		expect(parsed?.playlistHasEndList).toBe(true);
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

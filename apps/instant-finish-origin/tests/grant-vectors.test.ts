import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
	verifyInternalServiceRequest,
	verifyRevisionMediaGrant,
} from "../../../apps/web/lib/revision-media-token.ts";

type VectorCase = {
	id: string;
	kind: "grant" | "service";
	token: string;
	ring?: string[];
	now: number;
	expect: "accept" | "reject";
	method?: string;
	path?: string;
	body?: string;
};

type Vectors = {
	keys: Record<string, string>;
	serviceSecret: string;
	cases: VectorCase[];
};

const vectors = JSON.parse(
	readFileSync(new URL("./vectors/grant-service.json", import.meta.url), "utf8"),
) as Vectors;

const grantEnv = (ring: string[]) => ({
	REVISION_MEDIA_GRANT_KEYS: ring
		.map((id) => `${id}:${vectors.keys[id]}`)
		.join(","),
});

describe("shared grant and service vectors", () => {
	for (const item of vectors.cases) {
		test(item.id, () => {
			if (item.kind === "grant") {
				const verified = verifyRevisionMediaGrant(item.token, {
					now: item.now,
					env: grantEnv(item.ring ?? ["k1"]),
				});
				expect(verified.ok ? "accept" : "reject").toBe(item.expect);
				return;
			}
			const ok = verifyInternalServiceRequest(
				item.token,
				{
					method: item.method ?? "POST",
					path: item.path ?? "/",
					body: item.body ?? "",
					now: item.now,
				},
				{ REVISION_ORIGIN_SERVICE_SECRET: vectors.serviceSecret },
			);
			expect(ok ? "accept" : "reject").toBe(item.expect);
		});
	}
});

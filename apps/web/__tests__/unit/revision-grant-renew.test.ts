import { describe, expect, it } from "vitest";
import {
	createGrantKeeper,
	createGrantLoader,
	mediaGrantOf,
} from "@/lib/revision-playback";

const b64 = (o: object) =>
	btoa(JSON.stringify(o))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
// iat/exp deliberately far from the test clock: freshness must use receipt time.
const grant = (name: string) =>
	`prod57.${b64({ v: 1, iat: 10, exp: 70, n: name })}.sig`;

function keeper(renewTo: (string | null)[]) {
	let clock = 1_000_000;
	let calls = 0;
	const k = createGrantKeeper({
		grant: grant("A"),
		now: () => clock,
		renew: async () => {
			calls += 1;
			return renewTo.shift() ?? null;
		},
	});
	return {
		k,
		advance: (ms: number) => {
			clock += ms;
		},
		calls: () => calls,
	};
}

describe("revision grant keeper", () => {
	it("keeps the grant for its lifetime minus 20 s, then renews once", async () => {
		const t = keeper([grant("B")]);
		t.advance(39_000);
		expect(await t.k.fresh()).toBe(grant("A"));
		expect(t.calls()).toBe(0);
		t.advance(1_000);
		expect(await t.k.fresh()).toBe(grant("B"));
		expect(t.calls()).toBe(1);
		expect(await t.k.fresh()).toBe(grant("B"));
		expect(t.calls()).toBe(1);
	});

	it("recovers after a long pause or sleep with a single renewal", async () => {
		const t = keeper([grant("B")]);
		t.advance(3 * 60 * 60 * 1000);
		const [x, y, z] = await Promise.all([
			t.k.fresh(),
			t.k.fresh(),
			t.k.fresh(),
		]);
		expect([x, y, z]).toEqual([grant("B"), grant("B"), grant("B")]);
		expect(t.calls()).toBe(1);
	});

	it("keeps the old grant when renewal is denied or offline, and retries next time", async () => {
		const t = keeper([null, grant("C")]);
		t.advance(60_000);
		expect(await t.k.fresh()).toBe(grant("A"));
		expect(await t.k.fresh()).toBe(grant("C"));
		expect(t.calls()).toBe(2);
		const offline = createGrantKeeper({
			grant: grant("A"),
			now: () => Date.now() + 120_000,
			renew: () => Promise.reject(new TypeError("Failed to fetch")),
		});
		expect(await offline.fresh()).toBe(grant("A"));
	});
});

describe("revision grant loader", () => {
	it("stamps the fresh grant on media requests only and honours abort", async () => {
		const seen: string[] = [];
		class Base {
			load(context: { url: string }) {
				seen.push(context.url);
			}
			abort() {}
		}
		let current = "NEW";
		const Loader = createGrantLoader(
			Base as unknown as new (
				...args: never[]
			) => object,
			{ fresh: async () => current },
		);
		const loader = new Loader() as unknown as Base;
		loader.load({
			url: "https://cap.styrir.com/media/v/r/rev/seg/45.m4s?t=OLD",
		});
		loader.load({ url: "/media/v/r/rev/init.mp4?t=OLD&x=1" });
		loader.load({ url: "https://cdn.example.com/other.m4s?t=OLD" });
		loader.load({ url: "/media/v/r/rev/seg/1.m4s" });
		await Promise.resolve();
		current = "NEWER";
		loader.load({ url: "/media/v/r/rev/seg/46.m4s?t=OLD" });
		await Promise.resolve();
		const aborted = new Loader() as unknown as Base;
		aborted.load({ url: "/media/v/r/rev/seg/47.m4s?t=OLD" });
		aborted.abort();
		await Promise.resolve();
		await Promise.resolve();
		expect(seen.map((u) => mediaGrantOf(u)).sort()).toEqual(
			["NEW", "NEW", "NEWER", "OLD", null].sort(),
		);
		expect(seen.some((u) => u.includes("seg/47"))).toBe(false);
		expect(seen.find((u) => u.includes("init.mp4"))).toContain("x=1");
	});
});

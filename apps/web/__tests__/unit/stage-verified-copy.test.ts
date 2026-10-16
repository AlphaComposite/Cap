import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stageVerifiedCopy } from "@/lib/source-prepare-worker";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function store(objects: Record<string, string>) {
	const reads: string[] = [];
	return {
		reads,
		objects,
		async exists(k: string) {
			return k in objects;
		},
		async copy(a: string, b: string) {
			objects[b] = objects[a] as string;
		},
		async sha256(k: string) {
			reads.push(k);
			return k in objects ? sha(objects[k] as string) : null;
		},
	};
}

describe("stageVerifiedCopy", () => {
	it("copies, then reads each object exactly once", async () => {
		const s = store({ src: "video" });
		const out = await stageVerifiedCopy(s, "src", "dst");
		expect(out).toEqual({ sourceSha: sha("video"), copied: false });
		expect(s.objects.dst).toBe("video");
		expect(s.reads.sort()).toEqual(["dst", "src"]);
	});
	it("reuses an identical staged copy without copying", async () => {
		const s = store({ src: "video", dst: "video" });
		expect(await stageVerifiedCopy(s, "src", "dst")).toEqual({
			sourceSha: sha("video"),
			copied: true,
		});
	});
	it("rejects a staged copy with different bytes", async () => {
		const s = store({ src: "video", dst: "other" });
		await expect(stageVerifiedCopy(s, "src", "dst")).rejects.toThrow(
			"staged source identity changed",
		);
	});
	it("rejects a copy that does not match the source", async () => {
		const s = store({ src: "video" });
		s.copy = async (_a, b) => {
			s.objects[b] = "corrupt";
		};
		await expect(stageVerifiedCopy(s, "src", "dst")).rejects.toThrow(
			"stable copy sha mismatch",
		);
	});
	it("rejects a missing source", async () => {
		await expect(stageVerifiedCopy(store({}), "src", "dst")).rejects.toThrow(
			"source object missing before copy",
		);
	});
});

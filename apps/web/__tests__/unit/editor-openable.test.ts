import { describe, expect, it } from "vitest";
import { editorOpenable } from "../../lib/editor-openable";

const now = new Date("2026-01-01T00:00:00Z");
const sha256 = "c".repeat(64);
const source = {
	liveKey: "owner/video/result.mp4",
	sha256,
	relocationState: "LIVE",
	codec: "h264",
	timebase: "1/90000",
	frameMode: "cfr",
	a1Digest: sha256,
	indexId: "index",
	warmExpiresAt: new Date("2026-01-01T00:10:00Z"),
};
const relocation = {
	oldKey: source.liveKey,
	newKey: "private/source/video/original",
	sha256,
	state: "COPIED",
};
const facts = {
	videoId: "video",
	source,
	pending: true,
	now,
	relocations: [relocation],
};

describe("editor source admission", () => {
	it("does not admit an open outbox without a warm source", () => {
		expect(
			editorOpenable({ ...facts, source: { ...source, warmExpiresAt: null } }),
		).toBe(false);
	});
	it("admits a warm registered source with matching relocation", () => {
		expect(editorOpenable(facts)).toBe(true);
	});
	it("admits a registered PURGED source after the outbox is gone", () => {
		expect(
			editorOpenable({
				...facts,
				pending: false,
				source: {
					...source,
					relocationState: "PURGED",
					liveKey: "private/source/video/original",
				},
			}),
		).toBe(true);
	});
	it("admits expired PURGED sources with an open caption row for inline re-prepare", () => {
		expect(
			editorOpenable({
				...facts,
				source: {
					...source,
					relocationState: "PURGED",
					liveKey: "private/source/video/original",
					warmExpiresAt: new Date("2025-12-31T23:59:00Z"),
				},
			}),
		).toBe(true);
	});
	it.each([
		{ source: null },
		{ source: { ...source, indexId: null } },
		{ source: { ...source, sha256: "bad" } },
		{ source: { ...source, warmExpiresAt: new Date("invalid") } },
		{ relocations: [{ ...relocation, state: "ABORTED" }] },
		{ relocations: [{ ...relocation, sha256: "b".repeat(64) }] },
	])("fails closed for incomplete source evidence %s", (change) => {
		expect(editorOpenable({ ...facts, ...change })).toBe(false);
	});
});

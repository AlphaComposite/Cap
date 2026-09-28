import { describe, expect, it } from "vitest";
import { revisionPageChapters } from "@/lib/revision-metadata-snapshot";

const snap = [
	{ title: "Intro", start: 0 },
	{ title: "Main", start: 900 },
];

describe("revisionPageChapters", () => {
	it("shows owner-edited chapters once the video row matches the published revision", () => {
		const edited = [
			{ title: "Intro", start: 0 },
			{ title: "Renamed", start: 905 },
		];
		expect(
			revisionPageChapters({
				snapshotChapters: snap,
				snapshotDuration: 1037.6,
				liveChapters: edited,
				liveDuration: 1037.6,
			}),
		).toEqual(edited);
	});

	it("keeps the revision chapters while the video row still holds another edition", () => {
		expect(
			revisionPageChapters({
				snapshotChapters: snap,
				snapshotDuration: 1037.6,
				liveChapters: [{ title: "Old", start: 69 }],
				liveDuration: 745.331,
			}),
		).toEqual(snap);
	});

	it("keeps the revision chapters when the row has none", () => {
		expect(
			revisionPageChapters({
				snapshotChapters: snap,
				snapshotDuration: 1037.6,
				liveChapters: null,
				liveDuration: 1037.6,
			}),
		).toEqual(snap);
	});
});

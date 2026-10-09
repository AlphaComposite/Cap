import { editIntent, editRevision } from "@cap/database/schema";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
	publication: vi.fn(),
	select: vi.fn(),
	where: vi.fn(),
	from: vi.fn(),
	join: vi.fn(),
}));
vi.mock("@cap/database", () => ({ db: () => ({ select: mocks.select }) }));
vi.mock("@/lib/revision-publication-read", () => ({
	getInstantFinishPublicationDto: mocks.publication,
}));
vi.mock("@/lib/revision-publication", () => ({
	RevisionPublicationError: Error,
	recordServerDraft: vi.fn(),
}));
vi.mock("@/lib/revision-publish", () => ({ loadOwnerVideo: vi.fn() }));
vi.mock("@/lib/instant-finish-flag", () => ({
	isInstantFinishEnabledForOwner: () => true,
}));

import { getEditorInstantFinishState } from "@/actions/videos/publish-revision";
import {
	createIdentityEditSpec,
	createTimelineStateFromEditSpec,
	getTimelineEditSpec,
} from "@/lib/video-edits";

const input = { videoId: "video" as never, ownerId: "owner" };
const publication = {
	enabled: true,
	generation: 1,
	draftVersion: 2,
	draftSession: "same-editor",
	currentRevisionId: "worker-identity",
};
const spec = getTimelineEditSpec(
	createTimelineStateFromEditSpec(createIdentityEditSpec(45.207)),
);
beforeEach(() => {
	vi.clearAllMocks();
	mocks.publication.mockResolvedValue(publication);
	mocks.select.mockReturnValue({ from: mocks.from });
	mocks.from.mockReturnValue({ innerJoin: mocks.join });
	mocks.join.mockReturnValue({ where: mocks.where });
	mocks.where.mockResolvedValue([{ canonicalSpec: spec }]);
});

it("refresh returns the current revision baseline with the session and counters", async () => {
	expect(await getEditorInstantFinishState(input)).toEqual({
		enabled: true,
		generation: 1,
		draftVersion: 2,
		draftSession: "same-editor",
		expectedEditSpec: spec,
	});
	expect(mocks.select).toHaveBeenCalledWith({
		canonicalSpec: editIntent.canonicalSpec,
	});
	expect(mocks.from).toHaveBeenCalledWith(editIntent);
	expect(mocks.join).toHaveBeenCalledWith(editRevision, expect.anything());
	expect(mocks.where).toHaveBeenCalledOnce();
});

it("refresh preserves rendered canonical ranges rather than recomputing authored ranges", async () => {
	const rendered = { ...spec, keepRanges: [{ start: 0.1, end: 45.2 }] };
	mocks.where.mockResolvedValue([{ canonicalSpec: rendered }]);
	expect((await getEditorInstantFinishState(input)).expectedEditSpec).toEqual(
		rendered,
	);
});

it.each(["no current", "missing intent"])(
	"refresh has no replacement baseline for %s",
	async (missing) => {
		if (missing === "no current")
			mocks.publication.mockResolvedValue({
				...publication,
				currentRevisionId: null,
			});
		else mocks.where.mockResolvedValue([]);
		expect(
			(await getEditorInstantFinishState(input)).expectedEditSpec,
		).toBeNull();
		if (missing === "no current") expect(mocks.select).not.toHaveBeenCalled();
	},
);

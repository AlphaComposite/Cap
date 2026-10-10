import {
	comments,
	editIntent,
	editRevision,
	sourceObject,
	sourceRelocation,
	videoEdits,
	videoPublication,
	videos,
} from "@cap/database/schema";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://localhost:3000" },
	serverEnv: () => ({ NEXTAUTH_SECRET: "publication-overlap-test-secret" }),
}));
vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@/lib/revision-media-grant", () => ({ bumpPolicyEpoch: vi.fn() }));

import {
	EDIT_TRANSCRIPT_VERSION,
	serializeEditTranscript,
} from "@/lib/edit-transcript";
import { encryptEditTranscriptObject } from "@/lib/edit-transcript-storage";
import { snapsCoveringRanges } from "@/lib/revision-duration-check";
import { signOriginAttestation } from "@/lib/revision-media-token";
import {
	finishInventoryProbe,
	prepareInstantFinishRevision,
	publishInstantFinishRevision,
} from "@/lib/revision-publication";
import type { OriginClient } from "@/lib/revision-publication-origin";
import { untouchedEditorSpec } from "@/lib/source-prepare";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fixture() {
	vi.stubEnv(
		"REVISION_ORIGIN_SERVICE_SECRET",
		"publication-overlap-origin-secret-32",
	);
	const spec = {
		...untouchedEditorSpec(10),
		manualKeepRanges: [
			{ start: 0, end: 4 },
			{ start: 6, end: 9 },
		],
		keepRanges: [
			{ start: 0, end: 4 },
			{ start: 6, end: 9 },
		],
	};
	const rows = new Map<unknown, Record<string, any>[]>([
		[videos, [{ id: "video", ownerId: "owner", metadata: {} }]],
		[
			videoPublication,
			[
				{
					videoId: "video",
					generation: 0,
					draftSession: "A",
					latestDraftVersion: 0,
					currentRevisionId: null,
					currentGeneration: null,
					publicationEpoch: 0,
					policyEpoch: 0,
				},
			],
		],
		[
			sourceObject,
			[
				{
					liveKey: "private/source/video/original",
					sha256: "a".repeat(64),
					codec: "h264",
					timebase: "1/1000",
					frameMode: "cfr",
					a1Digest: "b".repeat(64),
					indexId: "index",
					warmExpiresAt: new Date("2099-01-01"),
				},
			],
		],
		[
			sourceRelocation,
			[{ newKey: "private/source/video/original", state: "PURGED" }],
		],
		[editIntent, []],
		[editRevision, []],
		[videoEdits, []],
		[comments, []],
	]);
	const transaction = {
		select: () => ({
			from: (table: unknown) => {
				const result = rows.get(table) ?? [];
				return Object.assign(Promise.resolve(result), {
					where: () =>
						Object.assign(Promise.resolve(result), { for: async () => result }),
				});
			},
		}),
		insert: (table: unknown) => ({
			values: (value: Record<string, any>) => {
				const existing = rows.get(table) ?? [];
				if (table !== videoPublication)
					rows.set(table, [...existing, { ...value }]);
				return Object.assign(Promise.resolve(), {
					onDuplicateKeyUpdate: async () => undefined,
				});
			},
		}),
		update: (table: unknown) => ({
			set: (value: Record<string, any>) => ({
				where: async () => {
					for (const row of rows.get(table) ?? []) Object.assign(row, value);
					return [{ affectedRows: 1 }];
				},
			}),
		}),
	};
	const database = {
		...transaction,
		transaction: async <T>(
			run: (tx: typeof transaction) => Promise<T>,
		): Promise<T> => run(transaction),
	};
	const selectFrames = vi.fn<OriginClient["selectFrames"]>(async (body) => ({
		...body,
		keepIndexes: [0],
		keepRanges: [body.keepRanges[0]!],
	}));
	const prepareRevision = vi.fn<OriginClient["prepareRevision"]>(
		async (body) => {
			const snap = snapsCoveringRanges(body.keepRanges, 1000);
			const attestation = {
				attestationVersion: 2 as const,
				ready: true,
				decoded: true,
				decodedFrames: 1,
				seg0DecodedFrames: 1,
				playlistHasEndList: true as const,
				intentId: body.intentId,
				initSha256: "c".repeat(64),
				seg0Sha256: "d".repeat(64),
				playlistDurationSeconds: snap.durationSeconds,
				...snap,
			};
			const attestationBody = `${JSON.stringify(attestation)}\n`;
			return {
				...attestation,
				attestationBody,
				attestationMac: signOriginAttestation(attestationBody),
			};
		},
	);
	const origin: OriginClient = {
		selectFrames,
		prepareRevision,
		fetchArtifact: vi.fn(),
	};
	const input = {
		videoId: "video",
		editSpec: spec,
		baseGeneration: 0,
		draftVersion: 1,
		draftSession: "A",
	};
	return { database, rows, origin, input };
}

const transcript = encryptEditTranscriptObject(
	serializeEditTranscript({
		version: EDIT_TRANSCRIPT_VERSION,
		speechModelUsed: "test",
		durationMs: 10000,
		languageCode: "en",
		words: [
			{
				id: "kept",
				text: "kept",
				startMs: 1000,
				endMs: 1500,
				confidence: 1,
				speaker: null,
				channel: null,
			},
			{
				id: "omitted",
				text: "omitted",
				startMs: 7000,
				endMs: 7500,
				confidence: 1,
				speaker: null,
				channel: null,
			},
		],
	}),
	"owner",
	"video",
);

afterEach(() => {
	vi.unstubAllEnvs();
	delete finishInventoryProbe.listPrefix;
	delete finishInventoryProbe.getObject;
});

describe("publication independent transcript read", () => {
	it.each([publishInstantFinishRevision])(
		"overlaps the read with canonicalization, but prepares only the sealed spec (%#)",
		async (publish) => {
			const { database, rows, origin, input } = fixture();
			const inventory = deferred();
			const getObject = vi.fn(async () => transcript);
			finishInventoryProbe.getObject = getObject;
			finishInventoryProbe.listPrefix = async () => {
				await inventory.promise;
				return [];
			};
			const pending = publish(database, input, {
				origin,
				randomRevisionId: () => "revision",
			});
			try {
				await vi.waitFor(() => expect(getObject).toHaveBeenCalledOnce(), {
					timeout: 1000,
				});
				expect(origin.selectFrames).not.toHaveBeenCalled();
				expect(origin.prepareRevision).not.toHaveBeenCalled();
				expect(rows.get(videoPublication)?.[0]?.currentRevisionId).toBeNull();
			} finally {
				inventory.resolve();
				await pending;
			}
			const body = vi.mocked(origin.prepareRevision).mock.calls[0]![0];
			expect(body.keepRanges).toEqual([{ start: 0, end: 4 }]);
			expect(body.editSpec.keepRanges).toEqual(body.keepRanges);
			expect(body.captionsVtt).toContain("kept");
			expect(body.captionsVtt).not.toContain("omitted");
			expect(getObject).toHaveBeenCalledOnce();
		},
	);

	it("keeps READY captions tied to the prepared snapshot without preparing again", async () => {
		const { database, rows, origin, input } = fixture();
		finishInventoryProbe.getObject = async () => transcript;
		finishInventoryProbe.listPrefix = async () => [];
		const prepared = await prepareInstantFinishRevision(database, input, {
			origin,
			randomRevisionId: () => "revision",
		});
		const captions = rows.get(editRevision)?.[0]?.metadataSnapshot.captionsVtt;
		finishInventoryProbe.getObject = async () => null;
		await expect(
			publishInstantFinishRevision(database, input, { origin }),
		).resolves.toEqual(prepared);
		expect(origin.prepareRevision).toHaveBeenCalledOnce();
		expect(rows.get(editRevision)?.[0]?.state).toBe("CURRENT");
		expect(rows.get(editRevision)?.[0]?.metadataSnapshot.captionsVtt).toBe(
			captions,
		);
	});

	it("does not prepare or publish when the concurrent inventory gate fails", async () => {
		const { database, rows, origin, input } = fixture();
		const inventory = deferred();
		const getObject = vi.fn(async () => transcript);
		finishInventoryProbe.getObject = getObject;
		finishInventoryProbe.listPrefix = async (prefix) => {
			await inventory.promise;
			return [`${prefix}result.mp4`];
		};
		const pending = publishInstantFinishRevision(database, input, { origin });
		const rejected = expect(pending).rejects.toThrow();
		try {
			await vi.waitFor(() => expect(getObject).toHaveBeenCalledOnce(), {
				timeout: 1000,
			});
		} finally {
			inventory.resolve();
			await rejected;
		}
		expect(origin.prepareRevision).not.toHaveBeenCalled();
		expect(rows.get(editRevision)).toEqual([]);
		expect(rows.get(videoPublication)?.[0]?.currentRevisionId).toBeNull();
	});
});

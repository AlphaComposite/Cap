import {
	revisionOutbox,
	sourceObject,
	sourceRelocation,
	videoPublication,
	videos,
} from "@cap/database/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	SOURCE_PREPARE_JOB,
	stablePrivateSourceKey,
} from "@/lib/source-prepare";
import { deriveEditReadiness } from "@/lib/video-edit-readiness";

vi.mock("server-only", () => ({}));

const sha = "c".repeat(64);
const videoId = "vid-join";
const publicKey = "owner/vid-join/result.mp4";
const journalKey = `private/source/${videoId}/${sha}`;
const warmUntil = new Date(Date.now() + 60_000);

type Write = { op: string; table: unknown; data?: Record<string, unknown> };

function editorDb(input: {
	source?: Record<string, unknown> | null;
	stages?: Record<string, unknown>[];
	pending?: boolean;
	exhausted?: boolean;
	journalThrows?: boolean;
	generation?: number;
}) {
	const writes: Write[] = [];
	const source =
		input.source === undefined
			? {
					videoId,
					liveKey: publicKey,
					sha256: sha,
					relocationState: "LIVE",
					codec: "h264",
					timebase: "1/90000",
					frameMode: "cfr",
					a1Digest: sha,
					indexId: "bound-index",
					warmExpiresAt: warmUntil,
				}
			: input.source;
	const stages = input.stages ?? [
		{
			videoId,
			oldKey: publicKey,
			newKey: journalKey,
			sha256: sha,
			state: "COPIED",
		},
	];
	const rowsFor = (table: unknown) => {
		if (table === videos) return [{ ownerId: "owner-join", id: videoId }];
		if (table === sourceObject) return source ? [source] : [];
		if (table === sourceRelocation) {
			if (input.journalThrows) throw new Error("journal select failed");
			return stages;
		}
		if (table === revisionOutbox) {
			return input.pending === false
				? []
				: [
						{
							job: SOURCE_PREPARE_JOB,
							videoId,
							payload: { finished: false, exhausted: input.exhausted === true },
						},
					];
		}
		if (table === videoPublication) {
			return [
				{
					videoId,
					generation: input.generation ?? 4,
					draftSession: "kept-session",
					currentRevisionId: null,
				},
			];
		}
		return [];
	};
	const query = (rows: unknown[]) => {
		const result = Promise.resolve(rows);
		return Object.assign(result, {
			where: () => result,
			limit: () => result,
		});
	};
	return {
		writes,
		db: {
			select: () => ({
				from: (table: unknown) => query(rowsFor(table)),
			}),
			insert: (table: unknown) => ({
				values: (data: Record<string, unknown>) => {
					writes.push({ op: "insert", table, data });
					return {
						onDuplicateKeyUpdate: async () => undefined,
					};
				},
			}),
			update: (table: unknown) => ({
				set: (data: Record<string, unknown>) => ({
					where: async () => {
						writes.push({ op: "update", table, data });
					},
				}),
			}),
		},
	};
}

describe("pending editor join", () => {
	const prepare = vi.fn(async () => ({
		sourceKey: stablePrivateSourceKey(videoId),
		sha256: sha,
		codec: "h264",
		timebase: "1/90000",
		frameMode: "cfr" as const,
		a1Digest: sha,
		indexId: "bound-index",
		warmExpiresAt: warmUntil.toISOString(),
	}));
	const relocate = vi.fn(async () => ({
		liveKey: stablePrivateSourceKey(videoId),
		sha256: sha,
	}));

	beforeEach(() => {
		prepare.mockClear();
		relocate.mockClear();
	});

	it("joins the registered warm journal key without prepare, relocate, or liveKey flip", async () => {
		const harness = editorDb({});
		const { openInstantFinishEditor } = await import(
			"@/lib/revision-publication-read"
		);
		const opened = await openInstantFinishEditor(videoId, harness.db, {
			actionRefresh: false,
			stageWaitMs: 0,
			prepare,
			relocate,
		});
		expect(journalKey).not.toBe(stablePrivateSourceKey(videoId));
		expect(prepare).not.toHaveBeenCalled();
		expect(relocate).not.toHaveBeenCalled();
		expect(opened.generation).toBe(4);
		expect(opened.draftSession).toBe("kept-session");
		expect(
			harness.writes.some(
				(write) =>
					write.data?.liveKey != null ||
					write.table === videoPublication ||
					write.data?.generation != null,
			),
		).toBe(false);
	});

	it("returns retryable 409 when the journal select fails and does not relocate", async () => {
		const harness = editorDb({
			journalThrows: true,
			source: {
				videoId,
				liveKey: `private/source/${videoId}/warm.mp4`,
				sha256: sha,
				relocationState: "LIVE",
				codec: "h264",
				timebase: "1/90000",
				frameMode: "cfr",
				a1Digest: sha,
				indexId: "bound-index",
				warmExpiresAt: warmUntil,
			},
		});
		const { openInstantFinishEditor } = await import(
			"@/lib/revision-publication-read"
		);
		await expect(
			openInstantFinishEditor(videoId, harness.db, {
				actionRefresh: false,
				stageWaitMs: 0,
				prepare,
				relocate,
			}),
		).rejects.toMatchObject({ status: 409 });
		expect(prepare).not.toHaveBeenCalled();
		expect(relocate).not.toHaveBeenCalled();
	});

	it.each([
		{ pending: false, actionRefresh: true },
		{ pending: true, actionRefresh: false },
	])(
		"reuses a warm PURGED source with pending=$pending, actionRefresh=$actionRefresh without prepare",
		async ({ pending, actionRefresh }) => {
			const harness = editorDb({
				pending,
				source: {
					videoId,
					liveKey: `private/source/${videoId}/purged.mp4`,
					sha256: sha,
					relocationState: "PURGED",
					codec: "h264",
					timebase: "1/90000",
					frameMode: "cfr",
					a1Digest: sha,
					indexId: "bound-index",
					warmExpiresAt: warmUntil,
				},
				stages: [],
			});
			const { openInstantFinishEditor } = await import(
				"@/lib/revision-publication-read"
			);
			await openInstantFinishEditor(videoId, harness.db, {
				actionRefresh,
				stageWaitMs: 0,
				prepare,
				relocate,
			});
			expect(prepare).not.toHaveBeenCalled();
			expect(relocate).not.toHaveBeenCalled();
		},
	);

	it("keeps a transient preparation read unavailable and polling until recovery", async () => {
		const input = {
			journalThrows: true,
			pending: false,
			stages: [],
			source: {
				videoId,
				liveKey: journalKey,
				sha256: sha,
				relocationState: "PURGED",
				codec: "h264",
				timebase: "1/90000",
				frameMode: "cfr",
				a1Digest: sha,
				indexId: "bound-index",
				warmExpiresAt: warmUntil,
			},
		};
		const harness = editorDb(input);
		const { readEditorPreparation } = await import(
			"@/lib/revision-publication-read"
		);
		const project = async () => {
			const { sourcePrepare, editorOpenable } = await readEditorPreparation(
				harness.db as never,
				videoId,
			);
			return deriveEditReadiness({
				videoId,
				identity: "source",
				eligible: true,
				isPro: true,
				playbackAdmission: true,
				videoState: "processed",
				transcriptionStatus: "COMPLETE",
				aiGenerationStatus: "COMPLETE",
				transcriptRead: "ready",
				sourcePrepare,
				editorOpenable,
			});
		};
		const unavailable = await project();
		expect(unavailable.sourcePrepare).toBe("unavailable");
		expect(unavailable.poll).toBe(true);
		expect(unavailable.editorOpenable).toBe(false);
		expect(unavailable.rows[4]).toMatchObject({ state: "unavailable" });
		input.journalThrows = false;
		const recovered = await project();
		expect(recovered.sourcePrepare).toBe("done");
		expect(recovered.editorOpenable).toBe(true);
		expect(recovered.allDone).toBe(true);
		expect(recovered.poll).toBe(false);
	});

	it("re-prepares an expired PURGED source while the caption outbox remains open", async () => {
		const source = {
			videoId,
			liveKey: journalKey,
			sha256: sha,
			relocationState: "PURGED",
			codec: "h264",
			timebase: "1/90000",
			frameMode: "cfr",
			a1Digest: sha,
			indexId: "bound-index",
			warmExpiresAt: new Date(Date.now() - 60_000),
		};
		const harness = editorDb({ source, pending: true });
		const { openInstantFinishEditor, readEditorPreparation } = await import(
			"@/lib/revision-publication-read"
		);
		expect(
			(await readEditorPreparation(harness.db as never, videoId))
				.editorOpenable,
		).toBe(true);
		const opened = await openInstantFinishEditor(videoId, harness.db, {
			actionRefresh: false,
			stageWaitMs: 0,
			prepare,
			relocate,
		});
		expect(prepare).toHaveBeenCalledExactlyOnceWith({
			videoId,
			sourceKey: journalKey,
		});
		expect(relocate).not.toHaveBeenCalled();
		expect(opened.generation).toBe(4);
		expect(
			harness.writes.find((write) => write.table === sourceObject)?.data,
		).toMatchObject({ warmExpiresAt: warmUntil });
	});
});

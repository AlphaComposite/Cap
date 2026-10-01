import { createHash, randomBytes } from "node:crypto";
import { revisionOutbox, videos } from "@cap/database/schema";
import type { VideoEditSpec, VideoEditSpecV2 } from "@cap/database/types";
import { and, asc, eq, sql } from "drizzle-orm";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import {
	areEditSpecDocumentsEquivalent,
	createTimelineState,
	getTimelineEditSpec,
} from "@/lib/video-edits";
import { isCanonicalIdentitySpec } from "../../../packages/web-backend/src/identity-edit-spec";

export const SOURCE_PREPARE_JOB = "source-prepare";
export const SOURCE_PREPARE_REVISION_ID = "srcprep";
export const SOURCE_PREPARE_MAX_ATTEMPTS = 5;
export const SOURCE_PREPARE_LEASE_MS = 1_800_000;

export const SKIP_BACKFILL_VIDEO_IDS = [
	"52dsqm24ssd05e5",
	"5vbfqmtxt4jk6eh",
	"z9x58adx1ra8bm3",
	"jm3htv93g8emje8",
] as const;

export type SourcePreparePayload = {
	videoId: string;
	ownerId: string;
	sourceObjectKey: string;
	attempts: number;
	stableKey: string;
	sha256?: string;
	exhausted?: boolean;
	finished?: boolean;
	leaseUntilMs?: number;
	leaseToken?: string;
	notBeforeMs?: number;
	phase?: "queued" | "prepared" | "published" | "captions";
	captionDeadlineMs?: number;
};

export type SourcePrepareInsert = {
	videoId: string;
	revisionId: string;
	job: string;
	payload: SourcePreparePayload;
};

type ExistingPrepare = {
	videoId: string;
	job: string;
	payload?: {
		exhausted?: boolean;
		finished?: boolean;
		sourceObjectKey?: string;
	};
};

export function stablePrivateSourceKey(videoId: string): string {
	return `private/source/${videoId}/original`;
}

export function untouchedEditorSpec(sourceDuration: number): VideoEditSpecV2 {
	return getTimelineEditSpec(createTimelineState(sourceDuration));
}

export function isUntouchedEditorSpec(spec: unknown): boolean {
	return isCanonicalIdentitySpec(spec);
}

export function planSourcePrepareInsert(input: {
	flagged: boolean;
	videoId: string;
	ownerId: string;
	sourceObjectKey: string;
	inappropriate?: boolean;
	existing: ExistingPrepare[];
	now?: Date;
}): { action: "insert"; row: SourcePrepareInsert } | { action: "skip" } {
	if (!input.flagged || input.inappropriate) return { action: "skip" };
	if (!input.sourceObjectKey || input.sourceObjectKey.includes("raw-upload")) {
		return { action: "skip" };
	}
	const open = input.existing.some(
		(row) =>
			row.videoId === input.videoId &&
			row.job === SOURCE_PREPARE_JOB &&
			row.payload?.finished !== true,
	);
	if (open) return { action: "skip" };
	return {
		action: "insert",
		row: {
			videoId: input.videoId,
			revisionId: SOURCE_PREPARE_REVISION_ID,
			job: SOURCE_PREPARE_JOB,
			payload: {
				videoId: input.videoId,
				ownerId: input.ownerId,
				sourceObjectKey: input.sourceObjectKey,
				attempts: 0,
				stableKey: stablePrivateSourceKey(input.videoId),
				phase: "queued",
			},
		},
	};
}

export function sourcePrepareDue(
	payload: Pick<
		SourcePreparePayload,
		"leaseUntilMs" | "notBeforeMs" | "exhausted" | "finished"
	>,
	nowMs: number,
): boolean {
	if (payload.finished || payload.exhausted) return false;
	const lease = payload.leaseUntilMs ?? 0;
	const notBefore = payload.notBeforeMs ?? 0;
	return lease <= nowMs && notBefore <= nowMs;
}

export function claimSourcePrepare<
	T extends { id: number; payload: SourcePreparePayload },
>(rows: T[], nowMs: number): T | null {
	const due = rows
		.filter((row) => sourcePrepareDue(row.payload, nowMs))
		.sort((left, right) => left.id - right.id);
	return due[0] ?? null;
}

export function nextSourcePrepareAttempt(
	payload: SourcePreparePayload,
	nowMs: number,
	failed: boolean,
): SourcePreparePayload {
	if (!failed) return { ...payload, finished: true, leaseUntilMs: undefined };
	const attempts = payload.attempts + 1;
	if (attempts >= SOURCE_PREPARE_MAX_ATTEMPTS) {
		return {
			...payload,
			attempts,
			exhausted: true,
			leaseUntilMs: undefined,
			notBeforeMs: undefined,
		};
	}
	return {
		...payload,
		attempts,
		leaseUntilMs: undefined,
		notBeforeMs: nowMs + Math.min(30_000, 1_000 * 2 ** attempts),
	};
}

export function editorJoinPlan(input: {
	pending: boolean;
	exhausted: boolean;
	registeredPrivateKey: string | null;
	videoId: string;
}): { relocate: false; sourceKey: string } | { relocate: true } {
	if (input.pending && !input.exhausted) {
		return {
			relocate: false,
			sourceKey:
				input.registeredPrivateKey ?? stablePrivateSourceKey(input.videoId),
		};
	}
	return { relocate: true };
}

export type BaselinePlayback =
	| "legacy"
	| "hls"
	| "unavailable"
	| "recording-unavailable";

export function decideBaselinePlayback(input: {
	flagged: boolean;
	currentRevisionId: string | null;
	currentReadable: boolean;
	hasUserEdit: boolean;
	relocated: boolean;
	publicResultEligible: boolean;
	identityPending: boolean;
	prepareExhausted: boolean;
}): BaselinePlayback {
	if (!input.flagged) return "legacy";
	if (input.currentRevisionId && input.currentReadable) return "hls";
	const originalForbidden = input.hasUserEdit || input.relocated;
	if (!originalForbidden && input.publicResultEligible) return "legacy";
	if (
		input.identityPending &&
		!originalForbidden &&
		input.publicResultEligible
	) {
		return "legacy";
	}
	if (
		input.relocated ||
		input.prepareExhausted ||
		!input.publicResultEligible
	) {
		return "recording-unavailable";
	}
	return "unavailable";
}

export function intentBlocksLegacy(spec: unknown): boolean {
	return !isUntouchedEditorSpec(spec);
}

export function captionsHaveCues(vtt: string | null | undefined): boolean {
	if (!vtt) return false;
	return /\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(vtt);
}

export function captionClaim(input: {
	transcriptionStatus: string | null | undefined;
	vtt: string | null | undefined;
}): "ready" | "pending" | "unavailable" {
	if (captionsHaveCues(input.vtt)) return "ready";
	if (
		input.transcriptionStatus === "ERROR" ||
		input.transcriptionStatus === "FAILED"
	) {
		return "unavailable";
	}
	return "pending";
}

export function backfillDecision(input: {
	flagged: boolean;
	videoId: string;
	currentRevisionId: string | null;
	hasUserEditIntent: boolean;
	hasVideoEdits: boolean;
	openJob: boolean;
}): "enqueue" | "skip" {
	if (!input.flagged) return "skip";
	if ((SKIP_BACKFILL_VIDEO_IDS as readonly string[]).includes(input.videoId)) {
		return "skip";
	}
	if (
		input.currentRevisionId ||
		input.hasUserEditIntent ||
		input.hasVideoEdits
	) {
		return "skip";
	}
	if (input.openJob) return "skip";
	return "enqueue";
}

export type BaselineSourceAdmission = {
	key: string;
	sha256: string;
	codec: string;
	timebase: string;
	frameMode: "vfr" | "cfr";
	a1Digest: string;
	indexId: string;
	warmExpiresAt: Date;
};

export function admitBaselineSource(input: {
	spec: VideoEditSpec;
	source: BaselineSourceAdmission;
	now: Date;
}): {
	key: string;
	sha256: string;
	codec: string;
	timebase: string;
	frameMode: "vfr" | "cfr";
} {
	if (!isUntouchedEditorSpec(input.spec)) {
		throw new Error("Baseline admission requires the untouched editor V2 spec");
	}
	if (!input.source.key.startsWith("private/source/")) {
		throw new Error(
			"Baseline admission requires the registered private source",
		);
	}
	if (
		!input.source.sha256 ||
		!input.source.codec ||
		!input.source.timebase ||
		!input.source.a1Digest ||
		!input.source.indexId ||
		input.source.warmExpiresAt.getTime() <= input.now.getTime()
	) {
		throw new Error("Baseline admission requires a warm indexed source");
	}
	return {
		key: input.source.key,
		sha256: input.source.sha256,
		codec: input.source.codec,
		timebase: input.source.timebase,
		frameMode: input.source.frameMode,
	};
}

export function isRetainedIdentityRestoreSpec(spec: VideoEditSpecV2): boolean {
	const stripped = { ...spec };
	delete stripped.autoCutsInitialized;
	return isUntouchedEditorSpec(stripped);
}

export function identityFinishReuses(input: {
	currentIntentSpec: unknown;
	nextSpec: VideoEditSpec;
	currentRevisionId: string;
	currentState: string;
}): { reuse: boolean; revisionId: string | null } {
	if (input.currentState !== "CURRENT")
		return { reuse: false, revisionId: null };
	if (!isUntouchedEditorSpec(input.currentIntentSpec)) {
		return { reuse: false, revisionId: null };
	}
	if (!isUntouchedEditorSpec(input.nextSpec))
		return { reuse: false, revisionId: null };
	if (
		!areEditSpecDocumentsEquivalent(
			input.currentIntentSpec as VideoEditSpec,
			input.nextSpec,
		)
	) {
		return { reuse: false, revisionId: null };
	}
	return { reuse: true, revisionId: input.currentRevisionId };
}

export function retainedByCutGc(input: {
	revisions: Array<{ revisionId: string; state: string; intentSpec: unknown }>;
	sourceKeys: string[];
}): { revisionIds: string[]; sourceKeys: string[] } {
	return {
		revisionIds: input.revisions
			.filter(
				(row) =>
					row.state === "CURRENT" || isUntouchedEditorSpec(row.intentSpec),
			)
			.map((row) => row.revisionId),
		sourceKeys: input.sourceKeys.filter((key) =>
			key.startsWith("private/source/"),
		),
	};
}

export type PrepareSnapshot = {
	videoId: string;
	ownerId: string;
	sourceObjectKey: string;
	stableKey: string;
	flagged: boolean;
	currentRevisionId: string | null;
	currentIsIdentity: boolean;
	currentReadable: boolean;
	hasUserEdit: boolean;
	relocated: boolean;
	registeredPrivateKey: string | null;
	publicResultEligible: boolean;
	sourceIndexed: boolean;
	sourceWarm?: boolean;
	sourceSha256?: string;
	bindMatches: boolean;
	transcriptReady: boolean;
	captionsClaimed: boolean;
	journalOldKey?: string | null;
	journalNewKey?: string | null;
	journalState?: string | null;
	deletionPending?: boolean;
};

export type PrepareEffects = {
	copyStable: (input: {
		videoId: string;
		from: string;
		to: string;
	}) => Promise<{ sha256: string; skipped: boolean }>;
	prepare: (input: {
		videoId: string;
		sourceKey: string;
	}) => Promise<{ encoded: boolean; sha256: string }>;
	publishIdentity: (input: {
		videoId: string;
		sourceKey: string;
		sha256: string;
	}) => Promise<{ revisionId: string }>;
	relocateOriginal: (input: {
		videoId: string;
		sourceKey: string;
		oldKey: string;
	}) => Promise<void>;
	completeInventory: (input: { videoId: string }) => Promise<void>;
	refreshCaptions: (input: {
		videoId: string;
	}) => Promise<"ready" | "pending" | "unavailable">;
};

export async function advanceSourcePrepare(
	snapshot: PrepareSnapshot,
	effects: PrepareEffects,
	calls: { prepare: number; relocate: number; publish: number } = {
		prepare: 0,
		relocate: 0,
		publish: 0,
	},
): Promise<{
	done: boolean;
	exhaustedSafe: boolean;
	calls: { prepare: number; relocate: number; publish: number };
	playback: BaselinePlayback;
}> {
	const playback = decideBaselinePlayback({
		flagged: snapshot.flagged,
		currentRevisionId: snapshot.currentRevisionId,
		currentReadable: snapshot.currentReadable,
		hasUserEdit: snapshot.hasUserEdit,
		relocated: snapshot.relocated,
		publicResultEligible: snapshot.publicResultEligible,
		identityPending: !snapshot.currentRevisionId && !snapshot.hasUserEdit,
		prepareExhausted: false,
	});
	if (!snapshot.flagged)
		return { done: true, exhaustedSafe: true, calls, playback };
	if (
		snapshot.deletionPending &&
		snapshot.currentRevisionId &&
		!snapshot.currentReadable
	) {
		return { done: false, exhaustedSafe: true, calls, playback };
	}
	const resumeDeletion =
		snapshot.deletionPending &&
		snapshot.currentReadable &&
		snapshot.journalOldKey &&
		snapshot.journalNewKey
			? { oldKey: snapshot.journalOldKey, newKey: snapshot.journalNewKey }
			: null;
	if (
		snapshot.hasUserEdit ||
		(snapshot.currentRevisionId && !snapshot.currentIsIdentity)
	) {
		if (resumeDeletion) {
			calls.relocate += 1;
			await effects.relocateOriginal({
				videoId: snapshot.videoId,
				sourceKey: resumeDeletion.newKey,
				oldKey: resumeDeletion.oldKey,
			});
		}
		if (
			snapshot.currentRevisionId &&
			snapshot.currentReadable &&
			!snapshot.captionsClaimed
		) {
			const claim = await effects.refreshCaptions({
				videoId: snapshot.videoId,
			});
			if (claim !== "pending" && (snapshot.relocated || resumeDeletion))
				await effects.completeInventory({ videoId: snapshot.videoId });
			return {
				done: claim !== "pending",
				exhaustedSafe: true,
				calls,
				playback: "hls",
			};
		}
		if (snapshot.currentReadable && (snapshot.relocated || resumeDeletion))
			await effects.completeInventory({ videoId: snapshot.videoId });
		return { done: true, exhaustedSafe: true, calls, playback };
	}
	if (snapshot.currentIsIdentity && snapshot.currentReadable) {
		if (resumeDeletion) {
			calls.relocate += 1;
			await effects.relocateOriginal({
				videoId: snapshot.videoId,
				sourceKey: resumeDeletion.newKey,
				oldKey: resumeDeletion.oldKey,
			});
		} else if (!snapshot.relocated) {
			calls.relocate += 1;
			await effects.relocateOriginal({
				videoId: snapshot.videoId,
				sourceKey: snapshot.stableKey,
				oldKey: snapshot.sourceObjectKey,
			});
		}
		if (!snapshot.captionsClaimed) {
			const claim = await effects.refreshCaptions({
				videoId: snapshot.videoId,
			});
			if (claim === "pending") {
				return { done: false, exhaustedSafe: true, calls, playback: "hls" };
			}
		}
		await effects.completeInventory({ videoId: snapshot.videoId });
		return { done: true, exhaustedSafe: true, calls, playback: "hls" };
	}
	const sourceKey = snapshot.relocated
		? (snapshot.registeredPrivateKey ?? snapshot.stableKey)
		: snapshot.stableKey;
	if (!snapshot.relocated && snapshot.journalState !== "PURGED") {
		await effects.copyStable({
			videoId: snapshot.videoId,
			from: snapshot.sourceObjectKey,
			to: sourceKey,
		});
	}
	if (
		!snapshot.sourceIndexed ||
		!snapshot.bindMatches ||
		snapshot.sourceWarm === false
	) {
		calls.prepare += 1;
		await effects.prepare({ videoId: snapshot.videoId, sourceKey });
	}
	if (!snapshot.currentRevisionId || !snapshot.currentReadable) {
		calls.publish += 1;
		await effects.publishIdentity({
			videoId: snapshot.videoId,
			sourceKey,
			sha256: snapshot.sourceSha256 ?? "",
		});
	}
	const deferPublicDeletion =
		Boolean(snapshot.deletionPending) && !snapshot.currentReadable;
	if (
		!snapshot.relocated &&
		snapshot.journalState !== "PURGED" &&
		!deferPublicDeletion
	) {
		calls.relocate += 1;
		await effects.relocateOriginal({
			videoId: snapshot.videoId,
			sourceKey,
			oldKey: snapshot.sourceObjectKey,
		});
	}
	if (deferPublicDeletion) {
		return {
			done: false,
			exhaustedSafe: true,
			calls,
			playback:
				snapshot.publicResultEligible && !snapshot.relocated ? "legacy" : "hls",
		};
	}
	if (!snapshot.captionsClaimed) {
		const claim = await effects.refreshCaptions({ videoId: snapshot.videoId });
		if (claim === "pending") {
			return {
				done: false,
				exhaustedSafe: true,
				calls,
				playback:
					snapshot.publicResultEligible && !snapshot.relocated
						? "legacy"
						: "hls",
			};
		}
	}
	await effects.completeInventory({ videoId: snapshot.videoId });
	return {
		done: true,
		exhaustedSafe: true,
		calls,
		playback:
			snapshot.publicResultEligible && !snapshot.relocated ? "legacy" : "hls",
	};
}

type OutboxRow = { id?: number; payload?: unknown };
type LockableQuery = Promise<OutboxRow[]> & {
	for?: (
		mode: "update",
		options?: { skipLocked?: boolean },
	) => Promise<OutboxRow[]>;
	orderBy?: (clause: unknown) => LockableQuery;
	limit?: (count: number) => LockableQuery;
};
type OutboxTx = {
	select: () => {
		from: (table: unknown) => {
			where: (clause: unknown) => LockableQuery;
		};
	};
	insert: (table: unknown) => {
		values: (row: unknown) => Promise<unknown>;
	};
	update?: (table: unknown) => {
		set: (values: unknown) => {
			where: (clause: unknown) => Promise<unknown>;
		};
	};
	delete?: (table: unknown) => {
		where: (clause: unknown) => Promise<unknown>;
	};
	transaction?: <T>(fn: (tx: OutboxTx) => Promise<T>) => Promise<T>;
};

async function rowsFrom(
	queried: Promise<OutboxRow[]> | OutboxRow[],
): Promise<OutboxRow[]> {
	const rows = await queried;
	return Array.isArray(rows) ? rows : [];
}

async function lockParentVideo(tx: OutboxTx, videoId: string) {
	const selected = tx
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as never));
	if (typeof selected.for === "function") {
		await selected.for("update");
		return;
	}
	await selected;
}

function leaseMatches(id: number, token: string) {
	return and(
		eq(revisionOutbox.id, id),
		sql`JSON_UNQUOTE(JSON_EXTRACT(${revisionOutbox.payload}, '$.leaseToken')) = ${token}`,
	);
}

export type ReadyHook =
	| "desktop"
	| "progress"
	| "process-video"
	| "multipart-final"
	| "multipart-replacement"
	| "loom"
	| "raw-multipart"
	| "recording-complete"
	| "edit-render"
	| "remux-pending";

const VERIFIED_READY_HOOKS = new Set<ReadyHook>([
	"desktop",
	"progress",
	"process-video",
	"multipart-final",
	"multipart-replacement",
	"loom",
]);

export function hookEnqueueDecision(input: {
	hook: ReadyHook;
	flagged: boolean;
	videoId: string;
	ownerId: string;
	sourceObjectKey: string;
	existing: ExistingPrepare[];
	remuxPending?: boolean;
	editRender?: boolean;
	desktopSource?: boolean;
	now?: Date;
}): { action: "insert"; row: SourcePrepareInsert } | { action: "skip" } {
	if (!VERIFIED_READY_HOOKS.has(input.hook)) return { action: "skip" };
	if (input.hook === "multipart-final" && input.remuxPending) {
		return { action: "skip" };
	}
	if (input.hook === "progress" && (input.editRender || input.desktopSource)) {
		return { action: "skip" };
	}
	return planSourcePrepareInsert({
		flagged: input.flagged,
		videoId: input.videoId,
		ownerId: input.ownerId,
		sourceObjectKey: input.sourceObjectKey,
		existing: input.existing,
		now: input.now,
	});
}

export async function enqueueSourcePrepare(
	tx: OutboxTx,
	input: {
		videoId: string;
		ownerId: string;
		sourceObjectKey: string;
		inappropriate?: boolean;
		env?: Record<string, string | undefined>;
		now?: Date;
	},
): Promise<"inserted" | "skipped"> {
	const flagged = isInstantFinishEnabledForOwner(input.ownerId, input.env);
	if (!flagged || input.inappropriate) return "skipped";
	if (!input.sourceObjectKey || input.sourceObjectKey.includes("raw-upload")) {
		return "skipped";
	}
	const run = async (locked: OutboxTx): Promise<"inserted" | "skipped"> => {
		await lockParentVideo(locked, input.videoId);
		const existingQuery = locked
			.select()
			.from(revisionOutbox)
			.where(
				and(
					eq(revisionOutbox.videoId, input.videoId as never),
					eq(revisionOutbox.job, SOURCE_PREPARE_JOB),
				),
			);
		const existing = await rowsFrom(existingQuery);
		const planned = planSourcePrepareInsert({
			flagged: true,
			videoId: input.videoId,
			ownerId: input.ownerId,
			sourceObjectKey: input.sourceObjectKey,
			existing: existing.map((row) => ({
				videoId: input.videoId,
				job: SOURCE_PREPARE_JOB,
				payload: (row.payload ?? {}) as ExistingPrepare["payload"],
			})),
			now: input.now,
		});
		if (planned.action === "skip") return "skipped";
		await locked.insert(revisionOutbox).values({
			videoId: input.videoId,
			revisionId: planned.row.revisionId,
			job: planned.row.job,
			payload: planned.row.payload,
			createdAt: input.now ?? new Date(),
		});
		return "inserted";
	};
	if (tx.transaction) return tx.transaction(run);
	return run(tx);
}

export async function enqueueVerifiedReady(
	tx: OutboxTx,
	input: {
		hook: ReadyHook;
		videoId: string;
		ownerId: string;
		sourceObjectKey: string;
		remuxPending?: boolean;
		editRender?: boolean;
		desktopSource?: boolean;
		env?: Record<string, string | undefined>;
		now?: Date;
	},
): Promise<"inserted" | "skipped"> {
	const flagged = isInstantFinishEnabledForOwner(input.ownerId, input.env);
	const decision = hookEnqueueDecision({
		hook: input.hook,
		flagged,
		videoId: input.videoId,
		ownerId: input.ownerId,
		sourceObjectKey: input.sourceObjectKey,
		existing: [],
		remuxPending: input.remuxPending,
		editRender: input.editRender,
		desktopSource: input.desktopSource,
		now: input.now,
	});
	if (decision.action === "skip") return "skipped";
	return enqueueSourcePrepare(tx, {
		videoId: input.videoId,
		ownerId: input.ownerId,
		sourceObjectKey: input.sourceObjectKey,
		env: input.env,
		now: input.now,
	});
}

export async function enqueueFlaggedBackfill(
	tx: OutboxTx,
	input: {
		videoId: string;
		ownerId: string;
		sourceObjectKey: string;
		currentRevisionId: string | null;
		hasUserEditIntent: boolean;
		hasVideoEdits: boolean;
		openJob: boolean;
		env?: Record<string, string | undefined>;
	},
): Promise<"inserted" | "skipped"> {
	if (
		backfillDecision({
			flagged: isInstantFinishEnabledForOwner(input.ownerId, input.env),
			videoId: input.videoId,
			currentRevisionId: input.currentRevisionId,
			hasUserEditIntent: input.hasUserEditIntent,
			hasVideoEdits: input.hasVideoEdits,
			openJob: input.openJob,
		}) !== "enqueue"
	) {
		return "skipped";
	}
	return enqueueSourcePrepare(tx, {
		videoId: input.videoId,
		ownerId: input.ownerId,
		sourceObjectKey: input.sourceObjectKey,
		env: input.env,
	});
}

export function sourceIdForKey(sourceKey: string): string {
	return createHash("sha256").update(sourceKey).digest("hex").slice(0, 32);
}

async function claimLockedSourcePrepare(database: OutboxTx, now: Date) {
	const claim = async (tx: OutboxTx) => {
		const nowMs = now.getTime();
		const selected = tx
			.select()
			.from(revisionOutbox)
			.where(
				and(
					eq(revisionOutbox.job, SOURCE_PREPARE_JOB),
					sql`(
						JSON_EXTRACT(${revisionOutbox.payload}, '$.leaseUntilMs') IS NULL
						OR CAST(JSON_UNQUOTE(JSON_EXTRACT(${revisionOutbox.payload}, '$.leaseUntilMs')) AS UNSIGNED) <= ${nowMs}
					)`,
					sql`(
						JSON_EXTRACT(${revisionOutbox.payload}, '$.notBeforeMs') IS NULL
						OR CAST(JSON_UNQUOTE(JSON_EXTRACT(${revisionOutbox.payload}, '$.notBeforeMs')) AS UNSIGNED) <= ${nowMs}
					)`,
					sql`(
						JSON_EXTRACT(${revisionOutbox.payload}, '$.finished') IS NULL
						OR JSON_UNQUOTE(JSON_EXTRACT(${revisionOutbox.payload}, '$.finished')) <> 'true'
					)`,
					sql`(
						JSON_EXTRACT(${revisionOutbox.payload}, '$.exhausted') IS NULL
						OR JSON_UNQUOTE(JSON_EXTRACT(${revisionOutbox.payload}, '$.exhausted')) <> 'true'
					)`,
				),
			);
		const ordered = selected.orderBy?.(asc(revisionOutbox.id)) ?? selected;
		const limited = ordered.limit?.(1) ?? ordered;
		const rows = (
			typeof limited.for === "function"
				? await limited.for("update", { skipLocked: true })
				: await limited
		) as Array<{ id: number; payload: SourcePreparePayload }>;
		const due = rows.find((row) => sourcePrepareDue(row.payload, nowMs));
		if (!due?.id || !tx.update) return null;
		const token = randomBytes(16).toString("hex");
		const payload: SourcePreparePayload = {
			...due.payload,
			leaseToken: token,
			leaseUntilMs: nowMs + SOURCE_PREPARE_LEASE_MS,
		};
		await tx
			.update(revisionOutbox)
			.set({ payload })
			.where(eq(revisionOutbox.id, due.id));
		return { id: due.id, payload, leaseToken: token };
	};
	if (database.transaction) return database.transaction(claim);
	return claim(database);
}

async function heartbeatSourcePrepare(
	database: OutboxTx,
	id: number,
	token: string,
	nowMs: number,
) {
	if (!database.update) return false;
	const [row] = (await database
		.select()
		.from(revisionOutbox)
		.where(eq(revisionOutbox.id, id))) as Array<{
		payload?: SourcePreparePayload;
	}>;
	if (row?.payload?.leaseToken !== token) return false;
	await database
		.update(revisionOutbox)
		.set({
			payload: {
				...row.payload,
				leaseToken: token,
				leaseUntilMs: nowMs + SOURCE_PREPARE_LEASE_MS,
			},
		})
		.where(leaseMatches(id, token));
	return true;
}

export async function sweepSourcePrepare(
	database: OutboxTx,
	input: {
		now?: Date;
		effects: PrepareEffects;
		load: (payload: SourcePreparePayload) => Promise<PrepareSnapshot>;
	},
): Promise<{ claimed: number; encoded: number }> {
	const now = input.now ?? new Date();
	const claimed = await claimLockedSourcePrepare(database, now);
	if (!claimed || !database.update || !database.delete) {
		return { claimed: 0, encoded: 0 };
	}
	const beat = () =>
		heartbeatSourcePrepare(
			database,
			claimed.id,
			claimed.leaseToken,
			Date.now(),
		);
	const timer = setInterval(() => {
		void beat().catch(() => false);
	}, 30_000);
	try {
		const snapshot = await input.load(claimed.payload);
		try {
			const held = await beat();
			if (!held) return { claimed: 1, encoded: 0 };
			const advanced = await advanceSourcePrepare(snapshot, input.effects);
			if (!(await beat()))
				return { claimed: 1, encoded: advanced.calls.prepare };
			if (advanced.done) {
				await database
					.delete(revisionOutbox)
					.where(leaseMatches(claimed.id, claimed.leaseToken));
			} else {
				const phaseNow = input.now ?? new Date();
				const captionDeadlineMs =
					claimed.payload.captionDeadlineMs ??
					phaseNow.getTime() + SOURCE_PREPARE_LEASE_MS;
				const exhausted = phaseNow.getTime() >= captionDeadlineMs;
				await database
					.update(revisionOutbox)
					.set({
						payload: {
							...claimed.payload,
							captionDeadlineMs,
							exhausted,
							finished: false,
							...(exhausted ? { error: "captions unavailable" } : {}),
							leaseToken: undefined,
							leaseUntilMs: undefined,
							notBeforeMs: phaseNow.getTime() + 5_000,
							phase: "captions",
						},
					})
					.where(leaseMatches(claimed.id, claimed.leaseToken));
			}
			return { claimed: 1, encoded: advanced.calls.prepare };
		} catch {
			if (await beat()) {
				await database
					.update(revisionOutbox)
					.set({
						payload: nextSourcePrepareAttempt(
							claimed.payload,
							now.getTime(),
							true,
						),
					})
					.where(leaseMatches(claimed.id, claimed.leaseToken));
			}
			return { claimed: 1, encoded: 0 };
		}
	} finally {
		clearInterval(timer);
	}
}

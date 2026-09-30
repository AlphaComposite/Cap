import type { db } from "@cap/database";
import {
	editIntent,
	editRevision,
	sourceObject,
	sourceRelocation,
	videoEdits,
	videoPublication,
	videos,
} from "@cap/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import type { OriginClient } from "@/lib/revision-publication-origin";
import { prepareSourceOnEditorOpen } from "@/lib/revision-publication-origin";
import {
	captionClaim,
	captionsHaveCues,
	isUntouchedEditorSpec,
	type PrepareSnapshot,
	SOURCE_PREPARE_JOB,
	type SourcePreparePayload,
	stablePrivateSourceKey,
	sweepSourcePrepare,
	untouchedEditorSpec,
} from "@/lib/source-prepare";

type App = ReturnType<typeof db>;

function asRows<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

export async function enqueueSourceCaptionsAfterTranscript(
	database: unknown,
	id: string,
): Promise<void> {
	const app = database as App;
	const [video] = await app
		.select({ ownerId: videos.ownerId })
		.from(videos)
		.where(eq(videos.id, id as never));
	const [source] = await app
		.select()
		.from(sourceObject)
		.where(eq(sourceObject.videoId, id as never));
	if (!video || !source || !isInstantFinishEnabledForOwner(video.ownerId))
		return;
	const { enqueueSourcePrepare } = await import("@/lib/source-prepare");
	await enqueueSourcePrepare(
		app as unknown as Parameters<typeof enqueueSourcePrepare>[0],
		{ videoId: id, ownerId: video.ownerId, sourceObjectKey: source.liveKey },
	);
}

export async function drainSourcePrepare(
	database: unknown,
	origin: unknown,
): Promise<{ claimed: number; encoded: number }> {
	const app = database as App;
	if (!origin || typeof app?.select !== "function") {
		return { claimed: 0, encoded: 0 };
	}
	try {
		return await sweepSourcePrepare(app as never, {
			load: (payload) =>
				loadPrepareSnapshot(app, payload, origin as OriginClient),
			effects: prepareEffects(app, origin),
		});
	} catch (error) {
		console.error("source-prepare drain failed");
		throw error;
	}
}

async function loadPrepareSnapshot(
	app: App,
	payload: SourcePreparePayload,
	origin: OriginClient,
): Promise<PrepareSnapshot> {
	const videoId = payload.videoId;
	const [video] = asRows<{
		ownerId: string;
		duration: number | null;
		transcriptionStatus: string | null;
		metadata: { summary?: string | null; chapters?: unknown } | null;
	}>(
		await app
			.select()
			.from(videos)
			.where(eq(videos.id, videoId as never)),
	);
	const [publication] = asRows<{ currentRevisionId: string | null }>(
		await app
			.select()
			.from(videoPublication)
			.where(eq(videoPublication.videoId, videoId as never)),
	);
	const [source] = asRows<{
		liveKey: string;
		relocationState: string;
		sha256: string;
		a1Digest: string | null;
		indexId: string | null;
		warmExpiresAt: Date | null;
	}>(
		await app
			.select()
			.from(sourceObject)
			.where(eq(sourceObject.videoId, videoId as never)),
	);
	const intents = asRows<{
		canonicalSpec: unknown;
		intentId: string;
		generation: number;
		sourceId: string;
	}>(
		await app
			.select()
			.from(editIntent)
			.where(eq(editIntent.videoId, videoId as never)),
	);
	const edits = asRows<{ videoId: string }>(
		await app
			.select()
			.from(videoEdits)
			.where(eq(videoEdits.videoId, videoId as never)),
	);
	const relocated = Boolean(
		source &&
			(source.relocationState !== "LIVE" ||
				source.liveKey.startsWith("private/")),
	);
	const userIntent = intents.some(
		(row) => !isUntouchedEditorSpec(row.canonicalSpec),
	);
	const [current] = publication?.currentRevisionId
		? await app
				.select()
				.from(editRevision)
				.where(
					and(
						eq(editRevision.videoId, videoId as never),
						eq(editRevision.revisionId, publication.currentRevisionId),
					),
				)
		: [];
	const currentIntent = current
		? intents.find(
				(row) =>
					row.intentId === current.intentId &&
					row.generation === current.generation &&
					row.sourceId === current.sourceId,
			)
		: undefined;
	const currentIsIdentity = Boolean(
		currentIntent && isUntouchedEditorSpec(currentIntent.canonicalSpec),
	);
	let currentReadable = false;
	if (current && current.state === "CURRENT" && currentIntent) {
		const artifacts = await Promise.all(
			["playlist.m3u8", "init.mp4", "seg/0.m4s"].map((name) =>
				origin.fetchArtifact({
					videoId,
					revisionId: current.revisionId,
					name,
					method: "GET",
				}),
			),
		);
		currentReadable =
			artifacts.every(
				(artifact) => artifact.status === 200 && artifact.body.length > 0,
			) && artifacts[0]!.body.toString("utf8").startsWith("#EXTM3U");
	}
	const stages = await app
		.select()
		.from(sourceRelocation)
		.where(eq(sourceRelocation.videoId, videoId as never));
	const matching = stages.filter(
		(row) =>
			row.sha256 === source?.sha256 &&
			/^[a-f0-9]{64}$/.test(row.sha256) &&
			row.newKey.startsWith(`private/source/${videoId}/`) &&
			["COPIED", "POINTER", "DELETED", "PURGED"].includes(row.state) &&
			(row.oldKey === source?.liveKey || row.newKey === source?.liveKey),
	);
	const stage =
		matching.find((row) =>
			["COPIED", "POINTER", "DELETED"].includes(row.state),
		) ?? matching.find((row) => row.state === "PURGED");
	const indexed = Boolean(source?.a1Digest && source.indexId);
	const warm =
		source?.warmExpiresAt instanceof Date &&
		source.warmExpiresAt.getTime() > Date.now();
	const boundToStage = Boolean(
		stage &&
			source?.liveKey === stage.newKey &&
			stage.sha256 === source.sha256 &&
			indexed &&
			warm,
	);
	return {
		videoId,
		ownerId: video?.ownerId ?? payload.ownerId,
		sourceObjectKey: payload.sourceObjectKey,
		stableKey:
			stage?.newKey ?? payload.stableKey ?? stablePrivateSourceKey(videoId),
		flagged: Boolean(
			video &&
				video.ownerId === payload.ownerId &&
				isInstantFinishEnabledForOwner(video.ownerId),
		),
		currentRevisionId: publication?.currentRevisionId ?? null,
		currentIsIdentity,
		currentReadable,
		hasUserEdit: userIntent || edits.length > 0,
		relocated,
		registeredPrivateKey: relocated ? (source?.liveKey ?? null) : null,
		publicResultEligible: !relocated,
		sourceIndexed: indexed,
		sourceWarm: Boolean(warm),
		sourceSha256: source?.sha256,
		bindMatches: stage ? boundToStage : indexed && Boolean(source?.sha256),
		transcriptReady: video?.transcriptionStatus === "COMPLETE",
		captionsClaimed: false,
		journalOldKey: stage?.oldKey ?? null,
		journalNewKey: stage?.newKey ?? null,
		journalState: stage?.state ?? null,
		deletionPending: Boolean(
			stage && ["COPIED", "POINTER", "DELETED"].includes(stage.state),
		),
	};
}

function prepareEffects(app: App, origin: unknown) {
	let prepared: Awaited<ReturnType<typeof prepareSourceOnEditorOpen>> | null =
		null;
	return {
		copyStable: async (input: {
			videoId: string;
			from: string;
			to: string;
		}) => {
			const { runtimeObjectStore, reconcileOriginReadPolicy } = await import(
				"@/lib/instant-finish-source-relocate"
			);
			const store = runtimeObjectStore();
			const sourceSha = await store.sha256(input.from);
			if (!sourceSha || !/^[a-f0-9]{64}$/.test(sourceSha))
				throw new Error("source object missing before copy");
			if (!input.to.startsWith(`private/source/${input.videoId}/`))
				throw new Error("staged source belongs to another video");
			const copied = await store.sha256(input.to);
			if (copied && copied !== sourceSha)
				throw new Error("staged source identity changed");
			if (!copied) await store.copy(input.from, input.to);
			if (
				(await store.sha256(input.to)) !== sourceSha ||
				(await store.sha256(input.from)) !== sourceSha
			) {
				throw new Error("stable copy sha mismatch");
			}
			await app.transaction(async (tx) => {
				const [video] = await tx
					.select()
					.from(videos)
					.where(eq(videos.id, input.videoId as never))
					.for("update");
				if (
					!video ||
					!input.from.startsWith(`${video.ownerId}/${input.videoId}/`)
				)
					throw new Error("original source is not owned by this video");
				const [registered] = await tx
					.select()
					.from(sourceObject)
					.where(eq(sourceObject.videoId, video.id));
				if (
					registered &&
					(registered.liveKey !== input.from || registered.sha256 !== sourceSha)
				) {
					throw new Error("registered source identity changed before staging");
				}
				if (!registered)
					await tx
						.insert(sourceObject)
						.values({
							videoId: video.id,
							liveKey: input.from,
							sha256: sourceSha,
							relocationState: "LIVE",
						});
				const stages = await tx
					.select()
					.from(sourceRelocation)
					.where(eq(sourceRelocation.videoId, video.id));
				const stage = stages.find(
					(row) =>
						row.oldKey === input.from &&
						row.newKey === input.to &&
						row.sha256 === sourceSha &&
						row.state !== "ABORTED",
				);
				if (stage) {
					if (stage.state === "INTENT")
						await tx
							.update(sourceRelocation)
							.set({ state: "COPIED" })
							.where(eq(sourceRelocation.id, stage.id));
				} else {
					await tx
						.insert(sourceRelocation)
						.values({
							videoId: video.id,
							revisionId: SOURCE_PREPARE_JOB,
							oldKey: input.from,
							newKey: input.to,
							sha256: sourceSha,
							state: "COPIED",
							createdAt: new Date(),
						});
				}
			});
			if (!(await reconcileOriginReadPolicy(app)))
				throw new Error("staged source policy is not ready");
			return { sha256: sourceSha, skipped: Boolean(copied) };
		},
		prepare: async (input: { videoId: string; sourceKey: string }) => {
			const [registered] = await app
				.select()
				.from(sourceObject)
				.where(eq(sourceObject.videoId, input.videoId as never));
			if (!registered || !/^[a-f0-9]{64}$/.test(registered.sha256))
				throw new Error(
					"source prepare requires a registered immutable identity",
				);
			const result = await prepareSourceOnEditorOpen(input);
			const expires = new Date(result.warmExpiresAt);
			if (
				result.sourceKey !== input.sourceKey ||
				result.sha256 !== registered.sha256 ||
				(registered.a1Digest && result.a1Digest !== registered.a1Digest) ||
				(registered.indexId && result.indexId !== registered.indexId) ||
				!/^[a-f0-9]{64}$/.test(result.a1Digest) ||
				!result.indexId ||
				!Number.isFinite(expires.getTime()) ||
				expires.getTime() <= Date.now()
			) {
				throw new Error(
					"native prepared identity did not match the registered source",
				);
			}
			await app
				.update(sourceObject)
				.set({
					codec: result.codec,
					timebase: result.timebase,
					frameMode: result.frameMode,
					a1Digest: result.a1Digest,
					indexId: result.indexId,
					warmExpiresAt: expires,
				})
				.where(
					and(
						eq(sourceObject.videoId, input.videoId as never),
						eq(sourceObject.sha256, result.sha256),
					),
				);
			prepared = result;
			return { encoded: true, sha256: result.sha256 };
		},
		publishIdentity: async (input: {
			videoId: string;
			sourceKey: string;
			sha256: string;
		}) => {
			const { publishInstantFinishRevision } = await import(
				"@/lib/revision-publication"
			);
			const [video] = asRows<{
				duration: number | null;
				metadata: {
					chapters?: { title: string; start: number }[];
					sourceChapters?: { title: string; start: number }[];
				} | null;
			}>(
				await app
					.select()
					.from(videos)
					.where(eq(videos.id, input.videoId as never)),
			);
			const [source] = asRows<{
				liveKey: string;
				sha256: string;
				codec: string | null;
				timebase: string | null;
				frameMode: string | null;
				a1Digest: string | null;
				indexId: string | null;
				warmExpiresAt: Date | null;
			}>(
				await app
					.select()
					.from(sourceObject)
					.where(eq(sourceObject.videoId, input.videoId as never)),
			);
			const warm = prepared;
			if (
				!warm &&
				source?.liveKey &&
				source.liveKey !== input.sourceKey &&
				!source.liveKey.startsWith("private/")
			) {
				throw new Error("refusing to publish an unverified public source");
			}
			const identity = warm ?? {
				sourceKey: input.sourceKey,
				sha256: input.sha256 || source?.sha256 || "",
				codec: source?.codec ?? "",
				timebase: source?.timebase ?? "",
				frameMode: source?.frameMode === "cfr" ? "cfr" : "vfr",
				a1Digest: source?.a1Digest ?? "",
				indexId: source?.indexId ?? "",
				warmExpiresAt: source?.warmExpiresAt?.toISOString() ?? "",
			};
			const duration = video?.duration;
			if (duration == null || duration <= 0) {
				throw new Error("source duration is unknown");
			}
			const published = await publishInstantFinishRevision(
				app,
				{
					videoId: input.videoId,
					editSpec: untouchedEditorSpec(duration),
					baseGeneration: 0,
					draftVersion: 0,
					draftSession: SOURCE_PREPARE_JOB,
					chapters: video?.metadata?.chapters ?? [],
					sourceChapters:
						video?.metadata?.sourceChapters ?? video?.metadata?.chapters ?? [],
					sourceDuration: duration,
					baselineIdentity: {
						key: identity.sourceKey,
						sha256: identity.sha256,
						codec: identity.codec,
						timebase: identity.timebase,
						frameMode: identity.frameMode === "cfr" ? "cfr" : "vfr",
						a1Digest: identity.a1Digest,
						indexId: identity.indexId,
						warmExpiresAt: new Date(identity.warmExpiresAt),
					},
				},
				{ origin: origin as never },
			);
			return { revisionId: published.revisionId };
		},
		relocateOriginal: async (input: {
			videoId: string;
			sourceKey: string;
			oldKey: string;
		}) => {
			const { continueRelocation } = await import("@/lib/source-relocation");
			const {
				drizzleRelocationJournal,
				runtimeObjectStore,
				reconcileOriginReadPolicy,
			} = await import("@/lib/instant-finish-source-relocate");
			if (!input.oldKey)
				throw new Error("original key missing from durable payload");
			const journal = drizzleRelocationJournal(app);
			const rows = await journal.listForVideo(input.videoId);
			const row = rows.find(
				(item) =>
					item.oldKey === input.oldKey &&
					item.newKey === input.sourceKey &&
					item.state !== "ABORTED",
			);
			if (!row)
				throw new Error(
					"registered copied source is missing before relocation resume",
				);
			await continueRelocation(row, runtimeObjectStore(), journal, {
				kind: "original",
			});
			if (!(await reconcileOriginReadPolicy(app)))
				throw new Error("relocated source policy is not ready");
		},
		refreshCaptions: async (input: { videoId: string }) => {
			const { refreshCurrentRevisionCaptions } = await import(
				"@/lib/revision-caption-refresh"
			);
			return refreshCurrentRevisionCaptions(
				app,
				input.videoId,
				origin as OriginClient,
			);
		},
	};
}

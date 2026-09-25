import { db } from "@cap/database";
import { spaceVideos, videos } from "@cap/database/schema";
import { provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import {
	evaluatePresentedGrant,
	type GrantDenial,
	getRevisionPlaybackUrl,
	signRevisionMediaGrant,
	verifyRevisionMediaGrant,
} from "@/lib/revision-media-token";
import { runPromise } from "@/lib/server";

export type MediaViewer = { id: string } | null;

export type PolicyView = "allow" | "deny" | "password" | "missing";

export type PublicationView = {
	currentRevisionId: string | null;
	generation: number;
	publicationEpoch: number;
	policyEpoch: number;
};

export type GrantIssueResult =
	| { enabled: false }
	| {
			enabled: true;
			ok: true;
			videoId: string;
			revisionId: string;
			publicationEpoch: number;
			policyEpoch: number;
			grant: string;
			playbackUrl: string;
			expiresAt: number;
	  }
	| {
			enabled: true;
			ok: false;
			status: 401 | 403 | 404 | 410 | 503;
			reason: string;
	  };

type SqlExecutor = {
	execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

const isMissingTable = (error: unknown): boolean => {
	const record =
		typeof error === "object" && error !== null
			? (error as { errno?: number; code?: string; cause?: unknown })
			: null;
	if (record?.errno === 1146 || record?.code === "ER_NO_SUCH_TABLE")
		return true;
	const cause = record?.cause;
	if (cause === undefined || cause === error) return false;
	return isMissingTable(cause);
};

export async function readPublication(
	videoId: string,
	executor: SqlExecutor = db(),
): Promise<PublicationView | null | "missing_table"> {
	try {
		const result = await executor.execute(sql`
			SELECT currentRevisionId, generation, publicationEpoch, policyEpoch
			FROM video_publication
			WHERE videoId = ${videoId}
			LIMIT 1
		`);
		const rows = Array.isArray(result)
			? result
			: ((result as { rows?: unknown[] }).rows ?? []);
		const row = (Array.isArray(rows[0]) ? rows[0][0] : rows[0]) as
			| PublicationView
			| undefined;
		if (!row) return null;
		return {
			currentRevisionId: row.currentRevisionId,
			generation: Number(row.generation),
			publicationEpoch: Number(row.publicationEpoch),
			policyEpoch: Number(row.policyEpoch),
		};
	} catch (error) {
		if (isMissingTable(error)) return "missing_table";
		throw error;
	}
}

export async function readArtifactReady(
	revisionId: string,
	artifact: string,
	executor: SqlExecutor = db(),
): Promise<boolean | "missing_table"> {
	try {
		const result = await executor.execute(sql`
			SELECT state
			FROM revision_artifact_status
			WHERE revisionId = ${revisionId} AND artifact = ${artifact}
			LIMIT 1
		`);
		const rows = Array.isArray(result)
			? result
			: ((result as { rows?: unknown[] }).rows ?? []);
		const row = (Array.isArray(rows[0]) ? rows[0][0] : rows[0]) as
			| { state?: string }
			| undefined;
		return row?.state === "ready" || row?.state === "READY";
	} catch (error) {
		if (isMissingTable(error)) return "missing_table";
		throw error;
	}
}

export async function bumpPolicyEpoch(
	videoId: string,
	executor: SqlExecutor = db(),
): Promise<void> {
	const [video] = await db()
		.select({ ownerId: videos.ownerId })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));
	if (!video) throw new Error("policy epoch bump failed closed");
	if (!isInstantFinishEnabledForOwner(video.ownerId)) return;
	try {
		await executor.execute(sql`
			UPDATE video_publication
			SET policyEpoch = policyEpoch + 1
			WHERE videoId = ${videoId}
		`);
	} catch (error) {
		if (isMissingTable(error)) {
			throw new Error("policy epoch bump failed closed");
		}
		throw error;
	}
}

export async function bumpPolicyEpochForVideos(
	videoIds: readonly string[],
	executor?: SqlExecutor,
): Promise<void> {
	for (const videoId of videoIds) {
		await bumpPolicyEpoch(videoId, executor);
	}
}

export async function bumpPolicyEpochForSpace(spaceId: string): Promise<void> {
	const rows = await db()
		.select({ videoId: spaceVideos.videoId })
		.from(spaceVideos)
		.where(
			eq(
				spaceVideos.spaceId,
				spaceId as (typeof spaceVideos.$inferSelect)["spaceId"],
			),
		);
	await bumpPolicyEpochForVideos(rows.map((row) => row.videoId));
}

export function evaluateGrantIssue(input: {
	flagged: boolean;
	policy: PolicyView;
	publication: PublicationView | null | "missing_table";
	videoPublic?: boolean;
}):
	| GrantIssueResult
	| {
			enabled: true;
			ok: true;
			revisionId: string;
			publicationEpoch: number;
			policyEpoch: number;
	  }
	| { enabled: false }
	| {
			enabled: true;
			ok: false;
			status: 401 | 403 | 404 | 410 | 503;
			reason: string;
	  } {
	if (!input.flagged) return { enabled: false };
	if (input.publication === "missing_table") {
		return {
			enabled: true,
			ok: false,
			status: 503,
			reason: "publication_unreadable",
		};
	}
	if (input.policy === "missing") {
		return { enabled: true, ok: false, status: 410, reason: "deleted" };
	}
	if (input.policy === "deny" || input.policy === "password") {
		return { enabled: true, ok: false, status: 403, reason: "unauthorized" };
	}
	if (!input.publication?.currentRevisionId) {
		return { enabled: true, ok: false, status: 404, reason: "no_publication" };
	}
	return {
		enabled: true,
		ok: true,
		revisionId: input.publication.currentRevisionId,
		publicationEpoch: input.publication.publicationEpoch,
		policyEpoch: input.publication.policyEpoch,
	};
}

export function issueGrantForPublication(input: {
	videoId: string;
	revisionId: string;
	publicationEpoch: number;
	policyEpoch: number;
	origin?: string;
	child?: string;
	now?: number;
	env?: NodeJS.ProcessEnv;
}) {
	const grant = signRevisionMediaGrant(
		{
			videoId: input.videoId,
			revisionId: input.revisionId,
			publicationEpoch: input.publicationEpoch,
			policyEpoch: input.policyEpoch,
			now: input.now,
		},
		input.env,
	);
	return {
		grant,
		playbackUrl: getRevisionPlaybackUrl({
			videoId: input.videoId,
			revisionId: input.revisionId,
			grant,
			origin: input.origin,
			child: input.child,
		}),
		expiresAt: (input.now ?? Math.floor(Date.now() / 1000)) + 60,
	};
}

export async function mintRevisionMediaGrant(
	_viewer: MediaViewer,
	videoId: string,
	options?: {
		now?: number;
		origin?: string;
		policy?: PolicyView;
		publication?: PublicationView | null | "missing_table";
		ownerId?: string;
		env?: NodeJS.ProcessEnv;
	},
): Promise<GrantIssueResult> {
	const ownerId =
		options?.ownerId ??
		(
			await db()
				.select({ ownerId: videos.ownerId })
				.from(videos)
				.where(eq(videos.id, videoId as Video.VideoId))
		)[0]?.ownerId;
	if (!ownerId) {
		return { enabled: true, ok: false, status: 410, reason: "deleted" };
	}
	const flagged = isInstantFinishEnabledForOwner(ownerId);
	const policy =
		options?.policy ??
		(await Effect.gen(function* () {
			const videosPolicy = yield* VideosPolicy;
			const loaded = yield* videosPolicy
				.getViewableById(Video.VideoId.make(videoId))
				.pipe(
					Effect.catchTag("PolicyDenied", () => Effect.fail("deny" as const)),
					Effect.catchTag("VerifyVideoPasswordError", () =>
						Effect.fail("password" as const),
					),
				);
			if (Option.isNone(loaded)) return "missing" as const;
			return "allow" as const;
		}).pipe(
			provideOptionalAuth,
			Effect.catchAll((error) =>
				Effect.succeed(
					error === "deny" || error === "password" ? error : ("deny" as const),
				),
			),
			runPromise,
		));
	const publication =
		options?.publication ?? (flagged ? await readPublication(videoId) : null);
	const decision = evaluateGrantIssue({
		flagged,
		policy,
		publication,
	});
	if (!decision.enabled || !("ok" in decision) || !decision.ok) {
		return decision;
	}
	const issued = issueGrantForPublication({
		videoId,
		revisionId: decision.revisionId,
		publicationEpoch: decision.publicationEpoch,
		policyEpoch: decision.policyEpoch,
		origin: options?.origin,
		now: options?.now,
		env: options?.env,
	});
	return {
		enabled: true,
		ok: true,
		videoId,
		revisionId: decision.revisionId,
		publicationEpoch: decision.publicationEpoch,
		policyEpoch: decision.policyEpoch,
		grant: issued.grant,
		playbackUrl: issued.playbackUrl,
		expiresAt: issued.expiresAt,
	};
}

export async function issueAuthorizedRevisionPlayback(input: {
	videoId: string;
	ownerId: string;
	origin?: string;
	now?: number;
	env?: NodeJS.ProcessEnv;
}): Promise<
	| { enabled: false }
	| { enabled: true; url: string | null; transcriptUrl: string | null }
> {
	if (!isInstantFinishEnabledForOwner(input.ownerId)) return { enabled: false };
	const publication = await readPublication(input.videoId);
	if (publication === "missing_table" || !publication?.currentRevisionId) {
		return { enabled: true, url: null, transcriptUrl: null };
	}
	const issued = issueGrantForPublication({
		videoId: input.videoId,
		revisionId: publication.currentRevisionId,
		publicationEpoch: publication.publicationEpoch,
		policyEpoch: publication.policyEpoch,
		origin: input.origin,
		now: input.now,
		env: input.env,
	});
	const captionsReady = await readArtifactReady(
		publication.currentRevisionId,
		"captions",
	);
	const transcriptUrl =
		captionsReady === true
			? getRevisionPlaybackUrl({
					videoId: input.videoId,
					revisionId: publication.currentRevisionId,
					grant: issued.grant,
					origin: input.origin,
					child: "captions.vtt",
				})
			: null;
	return { enabled: true, url: issued.playbackUrl, transcriptUrl };
}

export function classifyLiveGrant(
	token: string,
	live: {
		videoId: string;
		revisionId: string;
		publicationEpoch: number;
		policyEpoch: number;
		currentRevisionId: string | null;
		deleted: boolean;
		privateOrUnauthorized: boolean;
	},
	options?: { now?: number; env?: NodeJS.ProcessEnv },
): { ok: true } | { ok: false; denial: GrantDenial; status: 401 | 403 | 410 } {
	return evaluatePresentedGrant(verifyRevisionMediaGrant(token, options), live);
}

export function isFlaggedDirectObjectKey(
	key: string,
	ownerId: string,
	videoId: string,
) {
	const prefix = `${ownerId}/${videoId}/`;
	return key.startsWith(prefix) && !key.startsWith(`${prefix}private/`);
}

export function denyFlaggedPresign(input: {
	ownerId: string;
	videoId: string;
	key?: string;
	videoType?: string;
}): { deny: false } | { deny: true; status: 404 } {
	if (!isInstantFinishEnabledForOwner(input.ownerId)) return { deny: false };
	const videoType = input.videoType ?? "";
	if (
		videoType === "raw-preview" ||
		videoType === "mp4" ||
		videoType === "video" ||
		videoType.startsWith("segments")
	) {
		return { deny: true, status: 404 };
	}
	if (
		input.key &&
		isFlaggedDirectObjectKey(input.key, input.ownerId, input.videoId)
	) {
		return { deny: true, status: 404 };
	}
	return { deny: false };
}

export async function revisionArtifactUrl(input: {
	videoId: string;
	ownerId: string;
	artifact: "download" | "captions" | "thumbnail" | "preview";
	child: string;
	origin?: string;
}): Promise<string | null> {
	if (!isInstantFinishEnabledForOwner(input.ownerId)) return null;
	const publication = await readPublication(input.videoId);
	if (publication === "missing_table" || !publication?.currentRevisionId) {
		return null;
	}
	const ready = await readArtifactReady(
		publication.currentRevisionId,
		input.artifact,
	);
	if (ready !== true) return null;
	const issued = issueGrantForPublication({
		videoId: input.videoId,
		revisionId: publication.currentRevisionId,
		publicationEpoch: publication.publicationEpoch,
		policyEpoch: publication.policyEpoch,
		origin: input.origin,
		child: input.child,
	});
	return issued.playbackUrl;
}

export function ownerOriginalPath(videoId: string) {
	return `/api/media/original?videoId=${encodeURIComponent(videoId)}`;
}

import { db } from "@cap/database";
import {
	editIntent,
	sourceObject,
	videoEdits,
	videos,
} from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { intentBlocksOriginal } from "./identity-edit-spec.ts";
import { isInstantFinishEnabledForOwner } from "./Videos/instantFinishFlag.ts";

export type EligibleLegacyFacts = {
	flagged: boolean;
	hasEditIntent: boolean;
	hasVideoEdits: boolean;
	editProcessing: boolean;
	relocated: boolean;
};

export function isSourceRelocated(
	row:
		| { relocationState?: string | null; liveKey?: string | null }
		| null
		| undefined,
): boolean {
	if (!row) return false;
	if ((row.relocationState ?? "LIVE") !== "LIVE") return true;
	return isViewerPrivateKey(row.liveKey ?? "");
}

export function hasEditProcessing(metadata: unknown): boolean {
	if (!metadata || typeof metadata !== "object") return false;
	return (metadata as { editProcessing?: unknown }).editProcessing != null;
}

export function decideEligibleLegacy(facts: EligibleLegacyFacts): boolean {
	return (
		facts.flagged &&
		!facts.hasEditIntent &&
		!facts.hasVideoEdits &&
		!facts.editProcessing &&
		!facts.relocated
	);
}

export function isViewerPrivateKey(key: string): boolean {
	return key.startsWith("private/") || key.includes("/private/");
}

export async function loadEligibleLegacy(input: {
	videoId: string;
	ownerId: string;
	env?: Record<string, string | undefined>;
}): Promise<boolean> {
	if (!isInstantFinishEnabledForOwner(input.ownerId, input.env)) return false;
	const videoId = input.videoId as Video.VideoId;
	try {
		const database = db();
		const intents = await database
			.select({ spec: editIntent.canonicalSpec })
			.from(editIntent)
			.where(eq(editIntent.videoId, videoId));
		const [edit] = await database
			.select({ videoId: videoEdits.videoId })
			.from(videoEdits)
			.where(eq(videoEdits.videoId, videoId))
			.limit(1);
		const [video] = await database
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId))
			.limit(1);
		const [source] = await database
			.select({
				relocationState: sourceObject.relocationState,
				liveKey: sourceObject.liveKey,
			})
			.from(sourceObject)
			.where(eq(sourceObject.videoId, videoId))
			.limit(1);
		return decideEligibleLegacy({
			flagged: true,
			hasEditIntent: intents.some((intent) =>
				intentBlocksOriginal(intent.spec),
			),
			hasVideoEdits: edit != null,
			editProcessing: hasEditProcessing(video?.metadata),
			relocated: isSourceRelocated(source),
		});
	} catch {
		return false;
	}
}

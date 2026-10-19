import { db } from "@cap/database";
import {
	editIntent,
	editRevision,
	organizations,
	videoPublication,
	videos,
} from "@cap/database/schema";
import { parseAiGenerationLanguage, type Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { sleep } from "workflow";
import { isAiConfigured } from "@/lib/ai/provider";
import {
	clearRevisionChapterRegeneration,
	setGeneratedRevisionChapters,
} from "@/lib/ai-content-metadata";
import {
	mergeOwnerChapterEdit,
	projectSourceChapters,
	shouldRegenerateRevisionChapters,
} from "@/lib/revision-chapter-source";
import { loadStoredEditTranscript } from "@/lib/revision-publication";
import { deriveRevisionCaptions } from "@/lib/revision-publication-metadata";
import { captionsHaveCues } from "@/lib/source-prepare";
import { parseRenderedCanonicalSpec } from "@/lib/video-edits";
import { generateChaptersForTranscript } from "@/workflows/generate-ai";

type Payload = { videoId: string; revisionId: string };

export async function regenerateRevisionChaptersWorkflow(payload: Payload) {
	"use workflow";

	await sleep("30s");
	return regenerateRevisionChapters(payload);
}

export async function regenerateRevisionChapters({
	videoId,
	revisionId,
}: Payload) {
	"use step";

	try {
		if (!isAiConfigured()) return false;
		const app = db();
		const id = videoId as Video.VideoId;
		const [row] = await app
			.select({ video: videos, settings: organizations.settings })
			.from(videos)
			.leftJoin(organizations, eq(videos.orgId, organizations.id))
			.where(eq(videos.id, id));
		const [current] = await app
			.select({ revision: editRevision, spec: editIntent.canonicalSpec })
			.from(videoPublication)
			.innerJoin(
				editRevision,
				eq(editRevision.revisionId, videoPublication.currentRevisionId),
			)
			.innerJoin(editIntent, eq(editIntent.intentId, editRevision.intentId))
			.where(
				and(
					eq(videoPublication.videoId, id),
					eq(videoPublication.currentRevisionId, revisionId),
				),
			);
		if (
			!row ||
			!current ||
			current.revision.revisionId !== revisionId ||
			current.revision.state !== "CURRENT"
		)
			return false;
		const spec = parseRenderedCanonicalSpec(current.spec);
		const snapshot = current.revision.metadataSnapshot;
		if (
			spec.version !== 2 ||
			!snapshot ||
			!shouldRegenerateRevisionChapters({
				sourceDuration: spec.sourceDuration,
				outputDuration: snapshot.durationSeconds,
				chaptersManuallyEdited: row.video.metadata?.chaptersManuallyEdited,
			})
		)
			return false;
		let vtt = snapshot.captionsVtt;
		if (!captionsHaveCues(vtt)) {
			vtt = deriveRevisionCaptions({
				transcript: await loadStoredEditTranscript(app, videoId, spec),
				nextSpec: spec,
			}).vtt;
		}
		if (!captionsHaveCues(vtt)) return false;
		const generatedChapters = await generateChaptersForTranscript(
			vtt,
			snapshot.durationSeconds,
			parseAiGenerationLanguage(row.settings?.aiGenerationLanguage),
		);

		return await app.transaction(async (tx) => {
			// Same lock order as publication and saveResults: videos, then publication.
			const [video] = await tx
				.select()
				.from(videos)
				.where(eq(videos.id, id))
				.for("update");
			const [publication] = await tx
				.select()
				.from(videoPublication)
				.where(eq(videoPublication.videoId, id))
				.for("update");
			if (
				!video ||
				video.metadata?.chaptersManuallyEdited === true ||
				publication?.currentRevisionId !== revisionId
			)
				return false;
			const sourceChapters = mergeOwnerChapterEdit({
				previousSourceChapters: video.metadata?.sourceChapters ?? [],
				currentSpec: spec,
				editedChapters: generatedChapters,
			});
			const chapters = projectSourceChapters(sourceChapters, spec);
			// Never trade the projected chapters for a lone one on a real meeting.
			if (chapters.length === 0 || (chapters.length < 2 && snapshot.durationSeconds >= 120))
				return false;
			await tx
				.update(videos)
				.set({
					metadata: setGeneratedRevisionChapters(
						sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.chaptersRegeneratedRevisionId', ${revisionId})`,
						{ chapters, sourceChapters, chaptersRevisionId: revisionId },
					),
				})
				.where(eq(videos.id, id));
			// Patch only chapters: caption/download refreshes and the pasted summary survive.
			await tx
				.update(editRevision)
				.set({
					metadataSnapshot: sql`JSON_SET(${editRevision.metadataSnapshot}, '$.chapters', CAST(${JSON.stringify(chapters)} AS JSON))`,
				})
				.where(
					and(
						eq(editRevision.revisionId, revisionId),
						eq(editRevision.state, "CURRENT"),
					),
				);
			return true;
		});
	} catch (error) {
		// Projected chapters stay in place; provider fallback is the only retry chain.
		console.error("Revision chapter regeneration failed", {
			videoId,
			revisionId,
			error,
		});
		return false;
	} finally {
		try {
			await clearRevisionChapterRegeneration(videoId, revisionId);
		} catch (error) {
			// The share polling deadline also bounds crashed or unreachable workflows.
			console.warn("Failed to clear pending revision chapters", error);
		}
	}
}
regenerateRevisionChapters.maxRetries = 0;

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	editIntent,
	editRevision,
	videoEdits,
	videoPublication,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getVideoDownloadInfo } from "@/actions/videos/download";
import {
	editorHasExistingEdits,
	selectEditorBaselineSpec,
} from "@/lib/editor-baseline";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import { resolveRevisionChapters } from "@/lib/revision-metadata-snapshot";
import {
	openInstantFinishEditor,
	selectEditorPlayback,
} from "@/lib/revision-publication-read";
import { isEditSourceKey } from "@/lib/video-edit-processing";
import { parseVideoEditSpec } from "@/lib/video-edits";
import { EditUpgradeGate } from "./EditUpgradeGate";
import { EditVideoClient } from "./EditVideoClient";
import { EditRecovery } from "./edit-recovery";

function isMp4BackedVideo(source: typeof videos.$inferSelect.source) {
	return source.type === "desktopMP4" || source.type === "webMP4";
}

export default async function EditVideoPage(props: {
	params: Promise<{ videoId: string }>;
}) {
	const params = await props.params;
	const videoId = Video.VideoId.make(params.videoId);
	const user = await getCurrentUser();

	if (!user) notFound();

	const [video] = await db()
		.select({
			id: videos.id,
			name: videos.name,
			ownerId: videos.ownerId,
			duration: videos.duration,
			width: videos.width,
			height: videos.height,
			source: videos.source,
			metadata: videos.metadata,
			isScreenshot: videos.isScreenshot,
			transcriptionStatus: videos.transcriptionStatus,
			uploadPhase: videoUploads.phase,
			rawFileKey: videoUploads.rawFileKey,
		})
		.from(videos)
		.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
		.where(eq(videos.id, videoId));

	if (
		!video ||
		video.ownerId !== user.id ||
		video.isScreenshot ||
		!isMp4BackedVideo(video.source) ||
		!video.duration ||
		video.duration <= 0
	) {
		notFound();
	}

	if (!userIsPro(user)) {
		return <EditUpgradeGate />;
	}

	if (
		video.uploadPhase &&
		isEditSourceKey({
			ownerId: video.ownerId,
			videoId,
			rawFileKey: video.rawFileKey,
		})
	) {
		return (
			<EditRecovery
				videoId={videoId}
				canRestore={
					!video.metadata?.editProcessing &&
					process.env.CAP_LEGACY_EDIT_RECOVERY === "enabled"
				}
			/>
		);
	}
	if (
		video.uploadPhase &&
		["uploading", "processing", "generating_thumbnail"].includes(
			video.uploadPhase,
		)
	) {
		notFound();
	}

	const [existingEdit] = await db()
		.select({ editSpec: videoEdits.editSpec })
		.from(videoEdits)
		.where(eq(videoEdits.videoId, videoId));
	const flagged = isInstantFinishEnabledForOwner(video.ownerId);
	const [publishedIntent] = flagged
		? await db()
				.select({
					canonicalSpec: editIntent.canonicalSpec,
					metadataSnapshot: editRevision.metadataSnapshot,
					revisionId: editRevision.revisionId,
				})
				.from(editIntent)
				.innerJoin(
					videoPublication,
					and(
						eq(videoPublication.videoId, editIntent.videoId),
						eq(videoPublication.currentGeneration, editIntent.generation),
					),
				)
				.innerJoin(
					editRevision,
					and(
						eq(editRevision.revisionId, videoPublication.currentRevisionId),
						eq(editRevision.generation, editIntent.generation),
					),
				)
				.where(eq(editIntent.videoId, videoId))
		: [];
	const initialEditSpec = selectEditorBaselineSpec({
		instantFinish: flagged,
		publishedIntentSpec: publishedIntent
			? parseVideoEditSpec(publishedIntent.canonicalSpec)
			: null,
		legacySpec: existingEdit ? parseVideoEditSpec(existingEdit.editSpec) : null,
		sourceDuration: video.duration ?? 0,
	});
	const opened = flagged ? await openInstantFinishEditor(videoId) : null;
	const originalDownload =
		!flagged && existingEdit
			? await getVideoDownloadInfo(videoId, "original")
			: null;
	if (!flagged && existingEdit && originalDownload?.success !== true) {
		throw new Error(
			originalDownload && "error" in originalDownload
				? originalDownload.error
				: "The original recording is unavailable, so this edit cannot be opened safely.",
		);
	}
	const playback = selectEditorPlayback({
		flagged,
		existingEdit: Boolean(existingEdit),
		ownerProxyUrl: opened?.playbackSrc ?? null,
		presignedOriginalUrl:
			originalDownload?.success === true ? originalDownload.downloadUrl : null,
		playlistUrl: `/api/playlist?userId=${video.ownerId}&videoId=${video.id}&videoType=mp4`,
	});

	const hasExistingEdits = editorHasExistingEdits({
		instantFinish: flagged,
		hasLegacyRow: Boolean(existingEdit),
		baseline: initialEditSpec,
	});

	return (
		<EditVideoClient
			chapters={
				publishedIntent
					? resolveRevisionChapters({
							currentRevisionId: publishedIntent.revisionId,
							snapshotChapters: publishedIntent.metadataSnapshot?.chapters,
							liveChapters: video.metadata?.chapters,
							liveChaptersRevisionId: video.metadata?.chaptersRevisionId,
						})
					: (video.metadata?.chapters ?? [])
			}
			sourceChapters={
				flagged
					? publishedIntent &&
						video.metadata?.chaptersRevisionId === publishedIntent.revisionId
						? (video.metadata?.sourceChapters ?? null)
						: null
					: undefined
			}
			hasExistingEdits={hasExistingEdits}
			initialEditSpec={initialEditSpec}
			playbackSrc={playback.playbackSrc}
			usesOriginalSource={playback.usesOriginalSource}
			video={{
				id: video.id,
				name: video.name,
				ownerId: video.ownerId,
				duration: video.duration,
				width: video.width,
				height: video.height,
				transcriptionStatus: video.transcriptionStatus,
			}}
		/>
	);
}

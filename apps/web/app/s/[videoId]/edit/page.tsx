import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videoEdits, videos, videoUploads } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getVideoDownloadInfo } from "@/actions/videos/download";
import { isEditSourceKey } from "@/lib/video-edit-processing";
import {
	areEditSpecsEquivalent,
	createIdentityEditSpec,
	parseVideoEditSpec,
} from "@/lib/video-edits";
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
	const initialEditSpec = existingEdit
		? parseVideoEditSpec(existingEdit.editSpec)
		: createIdentityEditSpec(video.duration);
	const originalDownload = existingEdit
		? await getVideoDownloadInfo(videoId, "original")
		: null;
	if (existingEdit && originalDownload?.success !== true) {
		throw new Error(
			originalDownload?.error ??
				"The original recording is unavailable, so this edit cannot be opened safely.",
		);
	}
	const playbackSrc =
		existingEdit && originalDownload?.success === true
			? originalDownload.downloadUrl
			: `/api/playlist?userId=${video.ownerId}&videoId=${video.id}&videoType=mp4`;

	const hasExistingEdits = existingEdit
		? !areEditSpecsEquivalent(
				initialEditSpec,
				createIdentityEditSpec(initialEditSpec.sourceDuration),
			)
		: false;

	return (
		<EditVideoClient
			hasExistingEdits={hasExistingEdits}
			initialEditSpec={initialEditSpec}
			playbackSrc={playbackSrc}
			usesOriginalSource={Boolean(existingEdit)}
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

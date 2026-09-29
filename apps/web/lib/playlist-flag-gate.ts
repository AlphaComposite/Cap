import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";

export type FlaggedPlaylistGate = "legacy" | "revision" | "unavailable";

const SEGMENT_TYPES = new Set([
	"segments-master",
	"segments-video",
	"segments-audio",
	"segments-status",
	"raw-preview",
]);

export function flaggedPlaylistGate(input: {
	ownerId: string;
	videoType: string;
	fileType?: string;
	sourceType: string;
	env?: NodeJS.ProcessEnv;
	eligibleLegacy?: boolean;
}): FlaggedPlaylistGate {
	if (!isInstantFinishEnabledForOwner(input.ownerId, input.env))
		return "legacy";
	const fileType = input.fileType ?? "";
	if (
		fileType === "transcription" ||
		fileType === "enhanced-audio" ||
		input.videoType === "raw-preview"
	) {
		return "unavailable";
	}
	const mp4Source =
		input.sourceType === "webMP4" || input.sourceType === "desktopMP4";
	const mp4Alias =
		input.videoType === "mp4" ||
		input.videoType === "master" ||
		input.videoType === "video" ||
		input.videoType === "audio";
	if (
		input.eligibleLegacy &&
		(SEGMENT_TYPES.has(input.videoType) || (mp4Source && mp4Alias))
	) {
		return "legacy";
	}
	if (
		fileType === "transcription" ||
		fileType === "enhanced-audio" ||
		SEGMENT_TYPES.has(input.videoType)
	) {
		return "unavailable";
	}
	if (mp4Source && mp4Alias) {
		return "revision";
	}
	return "unavailable";
}

export type VideoPreparationState =
	| "uploading"
	| "processing"
	| "processed"
	| "failed"
	| "unavailable";
export type TranscriptReadState =
	| "ready"
	| "empty"
	| "processing"
	| "unavailable";

export type EditReadiness = {
	videoId: string;
	identity: string;
	playbackAdmission: boolean;
	playbackVerified: false;
	manualEditing: boolean;
	transcriptUsable: boolean;
	videoState: VideoPreparationState;
	videoLabel: string;
	transcriptLabel: string;
	poll: boolean;
};

export function deriveEditReadiness(facts: {
	videoId: string;
	identity: string;
	eligible: boolean;
	isPro: boolean;
	playbackAdmission: boolean;
	videoState: VideoPreparationState;
	transcriptionStatus: string | null;
	transcriptRead: TranscriptReadState;
}): EditReadiness {
	const transcriptUsable =
		facts.eligible &&
		facts.isPro &&
		facts.transcriptionStatus === "COMPLETE" &&
		(facts.transcriptRead === "ready" || facts.transcriptRead === "empty");
	const transcriptLabel =
		facts.transcriptionStatus === "COMPLETE"
			? transcriptUsable
				? facts.transcriptRead === "empty"
					? "No speech detected"
					: "Transcript ready"
				: "Word timings unavailable"
			: facts.transcriptionStatus === "PROCESSING"
				? "Transcribing"
				: facts.transcriptionStatus === "ERROR"
					? "Transcription failed"
					: facts.transcriptionStatus === "SKIPPED"
						? "Transcription skipped"
						: facts.transcriptionStatus === "NO_AUDIO"
							? "No audio"
							: facts.transcriptionStatus === null
								? "Transcript not started"
								: "Transcript unavailable";
	return {
		videoId: facts.videoId,
		identity: facts.identity,
		playbackAdmission: facts.playbackAdmission,
		playbackVerified: false,
		manualEditing:
			facts.eligible &&
			facts.isPro &&
			facts.playbackAdmission &&
			facts.videoState === "processed",
		transcriptUsable,
		videoState: facts.videoState,
		videoLabel:
			facts.videoState === "processed" && facts.playbackAdmission
				? "Video processed"
				: facts.videoState === "uploading"
					? "Video uploading"
					: facts.videoState === "processing"
						? "Video processing"
						: facts.videoState === "failed"
							? "Video processing failed"
							: "Video preparation unavailable",
		transcriptLabel,
		poll:
			facts.videoState === "uploading" ||
			facts.videoState === "processing" ||
			(facts.videoState === "processed" &&
				facts.transcriptionStatus === null) ||
			facts.transcriptionStatus === "PROCESSING" ||
			facts.transcriptRead === "processing",
	};
}

export function publicationAdmitsPlayback(facts: {
	videoId: string;
	revisionVideoId: string;
	currentRevisionId: string | null;
	revisionId: string;
	currentGeneration: number | null;
	revisionGeneration: number;
	publicationEpoch: number;
	policyEpoch: number;
	revisionState: string;
	bucket: string | null;
	artifacts: (boolean | "missing_table")[];
}): boolean {
	return (
		facts.videoId === facts.revisionVideoId &&
		Boolean(facts.currentRevisionId) &&
		facts.currentRevisionId === facts.revisionId &&
		facts.currentGeneration !== null &&
		Number.isSafeInteger(facts.currentGeneration) &&
		facts.currentGeneration >= 0 &&
		facts.currentGeneration === facts.revisionGeneration &&
		Number.isSafeInteger(facts.publicationEpoch) &&
		facts.publicationEpoch >= 0 &&
		Number.isSafeInteger(facts.policyEpoch) &&
		facts.policyEpoch >= 0 &&
		["CURRENT", "READY"].includes(facts.revisionState) &&
		[null, "", "cap"].includes(facts.bucket) &&
		facts.artifacts.length === 3 &&
		facts.artifacts.every((ready) => ready === true)
	);
}

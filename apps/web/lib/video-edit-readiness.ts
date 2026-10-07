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

export type ProcessingStep = {
	id: "upload" | "video" | "transcript" | "ai" | "sourcePrepare";
	label: string;
	state: "waiting" | "running" | "done" | "failed" | "unavailable";
	reason?: string;
	retry?: "processing" | "transcript" | "ai";
};

export type EditReadiness = {
	videoId: string;
	identity: string;
	playbackAdmission: boolean;
	playbackVerified: false;
	manualEditing: boolean;
	editorOpenable: boolean;
	uploadPhase: string | null;
	transcriptionStatus: string | null;
	aiGenerationStatus: string | null;
	sourcePrepare: "queued" | "running" | "done" | "failed" | "unavailable";
	rows: ProcessingStep[];
	processingSummary: string;
	allDone: boolean;
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
	editorOpenable?: boolean;
	uploadPhase?: string | null;
	processingError?: string | null;
	canRetryProcessing?: boolean;
	aiGenerationStatus?: string | null;
	sourcePrepare?: EditReadiness["sourcePrepare"];
	sourcePrepareError?: string;
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
	const openable =
		facts.eligible &&
		facts.playbackAdmission &&
		facts.videoState === "processed" &&
		(facts.editorOpenable ?? true);
	const sourcePrepare = facts.sourcePrepare ?? (openable ? "done" : "queued");
	const aiStatus = facts.aiGenerationStatus ?? "UNAVAILABLE";
	const uploadFailed =
		facts.uploadPhase === "error" && !facts.canRetryProcessing;
	const transcriptTerminal = [
		"COMPLETE",
		"SKIPPED",
		"NO_AUDIO",
		"UNAVAILABLE",
	].includes(facts.transcriptionStatus ?? "");
	const rows: ProcessingStep[] = [
		{
			id: "upload",
			label: "Uploaded",
			state: uploadFailed
				? "failed"
				: facts.videoState === "uploading"
					? "running"
					: "done",
			reason: uploadFailed
				? facts.processingError || "Upload failed"
				: undefined,
		},
		{
			id: "video",
			label: "Video processed",
			state: uploadFailed
				? "waiting"
				: facts.videoState === "failed" || facts.videoState === "unavailable"
					? "failed"
					: facts.videoState === "processed" && facts.playbackAdmission
						? "done"
						: facts.videoState === "processing"
							? "running"
							: "waiting",
			reason:
				facts.videoState === "failed"
					? facts.processingError || "Video processing failed"
					: facts.videoState === "unavailable"
						? "Video preparation unavailable"
						: undefined,
			retry:
				facts.videoState === "failed" && facts.canRetryProcessing
					? "processing"
					: undefined,
		},
		{
			id: "transcript",
			label: "Transcript",
			state:
				facts.transcriptionStatus === "ERROR"
					? "failed"
					: transcriptTerminal
						? "done"
						: facts.transcriptionStatus === "PROCESSING"
							? "running"
							: "waiting",
			reason:
				facts.transcriptionStatus === "ERROR"
					? "Transcription failed"
					: ["SKIPPED", "NO_AUDIO", "UNAVAILABLE"].includes(
								facts.transcriptionStatus ?? "",
							)
						? transcriptLabel
						: undefined,
			retry: facts.transcriptionStatus === "ERROR" ? "transcript" : undefined,
		},
		{
			id: "ai",
			label: "Summary and chapters",
			state:
				aiStatus === "ERROR"
					? "failed"
					: ["COMPLETE", "SKIPPED", "UNAVAILABLE"].includes(aiStatus)
						? "done"
						: aiStatus === "PROCESSING"
							? "running"
							: "waiting",
			reason:
				aiStatus === "ERROR"
					? "Summary and chapters generation failed"
					: aiStatus === "SKIPPED"
						? "Generation skipped"
						: aiStatus === "UNAVAILABLE"
							? "Automatic generation unavailable"
							: undefined,
			retry:
				aiStatus === "ERROR" && facts.transcriptionStatus === "COMPLETE"
					? "ai"
					: undefined,
		},
		{
			id: "sourcePrepare",
			label: "Preparing for editing",
			// Editing is the gate; background caption work after that is not shown as "running".
			state:
				openable && sourcePrepare !== "failed"
					? "done"
					: sourcePrepare === "unavailable"
						? "unavailable"
						: sourcePrepare === "failed"
							? "failed"
							: sourcePrepare === "done"
								? "done"
								: sourcePrepare === "running"
									? "running"
									: "waiting",
			reason:
				sourcePrepare === "failed"
					? facts.sourcePrepareError || "Preparing for editing failed"
					: undefined,
		},
	];
	const progress = processingProgress(rows, facts.transcriptionStatus);
	return {
		videoId: facts.videoId,
		identity: facts.identity,
		playbackAdmission: facts.playbackAdmission,
		playbackVerified: false,
		manualEditing: facts.eligible && facts.isPro && openable,
		editorOpenable: openable,
		uploadPhase: facts.uploadPhase ?? null,
		transcriptionStatus: facts.transcriptionStatus,
		aiGenerationStatus: facts.aiGenerationStatus ?? null,
		sourcePrepare,
		rows,
		...progress,
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
			rows.some(
				(row) =>
					row.state === "unavailable" ||
					row.state === "running" ||
					(facts.videoState !== "failed" &&
						facts.videoState !== "unavailable" &&
						row.state === "waiting"),
			) || facts.transcriptRead === "processing",
	};
}

export function processingProgress(
	rows: ProcessingStep[],
	transcriptionStatus: string | null,
) {
	const allDone = rows.every((row) => row.state === "done");
	const failed = rows.find((row) => row.state === "failed");
	const active =
		rows.find((row) => row.state === "unavailable") ??
		rows.find((row) => row.state === "running") ??
		rows.find((row) => row.state === "waiting");
	return {
		allDone,
		processingSummary: allDone
			? "Ready to edit"
			: failed
				? `${failed.label} failed.`
				: active?.state === "unavailable"
					? `${active.label}: Checking…`
					: active
						? `${transcriptionStatus === "COMPLETE" ? "Transcript ready. " : ""}${active.label}${active.state === "waiting" ? " waiting" : " in progress"}.`
						: "Ready to edit",
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

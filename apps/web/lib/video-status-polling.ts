export type VideoStatusPollingData = {
	transcriptionStatus?: string | null;
	aiGenerationStatus?: string | null;
};

export type VideoStatusPollingAvailability = {
	aiGeneration: boolean;
	transcriptionGeneration: boolean;
};

export function shouldContinueVideoStatusPolling(
	data: VideoStatusPollingData,
	availability: VideoStatusPollingAvailability,
): boolean {
	if (!data.transcriptionStatus) {
		return availability.transcriptionGeneration;
	}

	if (data.transcriptionStatus === "PROCESSING") {
		return true;
	}

	if (
		data.transcriptionStatus === "ERROR" ||
		data.transcriptionStatus === "SKIPPED" ||
		data.transcriptionStatus === "NO_AUDIO"
	) {
		return false;
	}

	if (data.transcriptionStatus !== "COMPLETE") {
		return false;
	}

	if (!availability.aiGeneration) {
		return false;
	}

	if (
		data.aiGenerationStatus === "SKIPPED" ||
		data.aiGenerationStatus === "ERROR" ||
		data.aiGenerationStatus === "COMPLETE"
	) {
		return false;
	}

	return (
		data.aiGenerationStatus === "QUEUED" ||
		data.aiGenerationStatus === "PROCESSING" ||
		!data.aiGenerationStatus
	);
}

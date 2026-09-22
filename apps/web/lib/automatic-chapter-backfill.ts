import type { VideoMetadata } from "@cap/database/types";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

export type AutomaticChapterBackfillOptions = {
	apply: boolean;
	videoId?: string;
	limit: number;
};

export type AutomaticChapterBackfillRow = {
	id: string;
	ownerId: string;
	duration: number | null;
	transcriptionStatus: string | null;
	updatedAt: Date;
	metadata: VideoMetadata | null;
};

type BackfillClassification = {
	eligible: boolean;
	reason: string;
	chapterCount: number;
};

export type AutomaticChapterBackfillObservedState = {
	generationId: string | null;
	generationStatus: string | null;
	chaptersJson: string | null;
	chaptersManuallyEditedJson: string | null;
	transcriptionStatus: string | null;
	updatedAtJson: string;
};

export type AutomaticChapterBackfillOutput = {
	videoId: string;
	duration: number | null;
	currentChapterCount: number;
	reason: string;
	status: string;
};

export function isKnownLegacyAutomaticChapterState(
	row: Pick<
		AutomaticChapterBackfillRow,
		"duration" | "transcriptionStatus" | "metadata"
	>,
): boolean {
	return (
		row.transcriptionStatus === "COMPLETE" &&
		typeof row.duration === "number" &&
		Number.isFinite(row.duration) &&
		row.duration >= 20 * 60 &&
		row.metadata?.aiGenerationStatus === "COMPLETE" &&
		!row.metadata.aiGenerationId &&
		row.metadata.chaptersManuallyEdited !== true &&
		Array.isArray(row.metadata.chapters) &&
		row.metadata.chapters.length === 1
	);
}

export function parseAutomaticChapterBackfillArgs(
	argv: string[],
): AutomaticChapterBackfillOptions {
	let apply = false;
	let videoId: string | undefined;
	let limit = DEFAULT_LIMIT;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--apply") {
			apply = true;
			continue;
		}
		if (argument === "--dry-run") continue;
		if (argument === "--video-id") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) {
				throw new Error("--video-id requires a value");
			}
			videoId = value;
			index += 1;
			continue;
		}
		if (argument === "--limit") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) {
				throw new Error("--limit requires a value");
			}
			limit = Number(value);
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${argument}`);
	}

	if (!videoId && argv.includes("--video-id")) {
		throw new Error("--video-id requires a value");
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new Error(`--limit must be an integer between 1 and ${MAX_LIMIT}`);
	}
	if (apply && argv.includes("--dry-run")) {
		throw new Error("--apply and --dry-run cannot be combined");
	}

	return { apply, ...(videoId ? { videoId } : {}), limit };
}

export function classifyAutomaticChapterBackfill(
	row: AutomaticChapterBackfillRow,
): BackfillClassification {
	const chapters = row.metadata?.chapters;
	const chapterCount = Array.isArray(chapters) ? chapters.length : 0;
	const result = (
		eligible: boolean,
		reason: string,
	): BackfillClassification => ({ eligible, reason, chapterCount });

	if (row.transcriptionStatus !== "COMPLETE") {
		return result(false, "transcription-not-complete");
	}
	if (
		typeof row.duration !== "number" ||
		!Number.isFinite(row.duration) ||
		row.duration <= 0
	) {
		return result(false, "invalid-duration");
	}
	if (row.metadata?.chaptersManuallyEdited === true) {
		return result(false, "manual-chapters");
	}
	if (
		row.metadata?.aiGenerationStatus === "QUEUED" ||
		row.metadata?.aiGenerationStatus === "PROCESSING"
	) {
		return result(false, "generation-active");
	}
	if (chapters === undefined) return result(true, "chapters-missing");
	if (!Array.isArray(chapters)) return result(true, "chapters-malformed");
	if (chapters.length === 0) return result(true, "chapters-empty");

	let previousStart: number | undefined;
	for (const chapter of chapters) {
		if (
			typeof chapter !== "object" ||
			chapter === null ||
			typeof chapter.title !== "string" ||
			chapter.title.trim().length === 0 ||
			typeof chapter.start !== "number" ||
			!Number.isFinite(chapter.start) ||
			chapter.start < 0
		) {
			return result(true, "chapters-malformed");
		}
		if (chapter.start >= row.duration) {
			return result(true, "chapters-out-of-duration");
		}
		if (previousStart === chapter.start) {
			return result(true, "chapters-duplicate");
		}
		if (previousStart !== undefined && chapter.start < previousStart) {
			return result(true, "chapters-unsorted");
		}
		previousStart = chapter.start;
	}

	if (isKnownLegacyAutomaticChapterState(row)) {
		return result(true, "chapters-inadequate-for-duration");
	}
	return result(false, "chapters-valid");
}

export async function runAutomaticChapterBackfill(
	options: AutomaticChapterBackfillOptions,
	dependencies: {
		listVideos: (
			options: Pick<AutomaticChapterBackfillOptions, "videoId" | "limit">,
		) => Promise<AutomaticChapterBackfillRow[]>;
		startGeneration: (
			videoId: string,
			ownerId: string,
			observedState: AutomaticChapterBackfillObservedState,
		) => Promise<{ success: boolean; message: string }>;
	},
): Promise<AutomaticChapterBackfillOutput[]> {
	const rows = await dependencies.listVideos({
		videoId: options.videoId,
		limit: options.limit,
	});

	const output: AutomaticChapterBackfillOutput[] = [];
	for (const row of rows) {
		const classification = classifyAutomaticChapterBackfill(row);
		const record: AutomaticChapterBackfillOutput = {
			videoId: row.id,
			duration: row.duration,
			currentChapterCount: classification.chapterCount,
			reason: classification.reason,
			status: classification.eligible ? "would-start" : "skipped",
		};

		if (!options.apply || !classification.eligible) {
			output.push(record);
			continue;
		}

		try {
			const started = await dependencies.startGeneration(row.id, row.ownerId, {
				generationId: row.metadata?.aiGenerationId ?? null,
				generationStatus: row.metadata?.aiGenerationStatus ?? null,
				chaptersJson:
					row.metadata?.chapters === undefined
						? null
						: JSON.stringify(row.metadata.chapters),
				chaptersManuallyEditedJson:
					row.metadata?.chaptersManuallyEdited === undefined
						? null
						: JSON.stringify(row.metadata.chaptersManuallyEdited),
				transcriptionStatus: row.transcriptionStatus,
				updatedAtJson: row.updatedAt.toISOString(),
			});
			if (
				started.success &&
				started.message === "AI generation workflow started"
			) {
				record.status = "started";
			} else if (started.success) {
				record.reason = "concurrent-change";
				record.status = "skipped";
			} else {
				record.reason = "start-failed";
				record.status = "retryable";
			}
		} catch {
			record.reason = "start-failed";
			record.status = "retryable";
		}
		output.push(record);
	}
	return output;
}

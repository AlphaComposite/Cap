import { db } from "@cap/database";
import { organizations, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { Storage } from "@cap/web-backend/src/Storage/index";
import {
	AI_GENERATION_LANGUAGE_AUTO,
	type AiGenerationLanguage,
	getAiGenerationLanguageName,
	parseAiGenerationLanguage,
	type Video,
} from "@cap/web-domain";
import { generateText } from "ai";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { FatalError } from "workflow";
import { isAiConfigured } from "@/lib/ai/provider";
import { AiUnavailableError, runWithAiProviders } from "@/lib/ai/run";
import { hasValidChapterState } from "@/lib/ai-chapter-state";
import {
	type ChapterTranscriptEvidence,
	clampChapters,
	getMinimumUsefulChapterCount,
	getRequiredChapterSynthesisCount,
	validateChapterOrder,
	validateChapterStartsInSection,
	validateGeneratedChapters,
} from "@/lib/ai-chapter-validation";
import { setGeneratedAiContent } from "@/lib/ai-content-metadata";
import { enqueueVideoStorageNameSync } from "@/lib/sync-video-storage-names";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

interface GenerateAiWorkflowPayload {
	videoId: string;
	userId: string;
	generationId: string;
}

interface VideoData {
	video: typeof videos.$inferSelect;
	metadata: VideoMetadata;
	aiGenerationLanguage: AiGenerationLanguage;
}

interface VttSegment {
	start: number;
	end: number;
	text: string;
}

interface TranscriptData {
	segments: VttSegment[];
	text: string;
}

interface AiResult {
	title?: string;
	chapters?: { title: string; start: number }[];
}

// Preserve the pre-existing pure helper imports for callers that still use
// this workflow module. The validator itself remains available only from the
// DB-free lib module.
export {
	clampChapters,
	getMinimumUsefulChapterCount,
	getRequiredChapterSynthesisCount,
};

const getAffectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

const MAX_CHARS_PER_CHUNK = 24000;
const LEGACY_AI_TITLE_FALLBACK = "Generated Title";
const GENERATED_TITLE_PATTERN =
	/^(Cap (Recording|Upload) - .+|Cap \d{4}-\d{2}-\d{2} at \d{2}[.:]\d{2}[.:]\d{2}|Untitled|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|.+ \((Display|Window|Area|Camera)\) \d{4}-\d{2}-\d{2} \d{2}:\d{2} [AP]M)$/;

export function shouldReplaceVideoTitle({
	currentTitle,
	previousAiTitle,
	nextAiTitle,
	sourceName,
	titleManuallyEdited,
}: {
	currentTitle: string | null;
	previousAiTitle?: string | null;
	nextAiTitle?: string | null;
	sourceName?: string | null;
	titleManuallyEdited?: boolean | null;
}) {
	const nextTitle = nextAiTitle?.trim();
	if (!nextTitle) return false;
	if (titleManuallyEdited) return false;

	const title = currentTitle?.trim();
	if (!title) return true;
	if (previousAiTitle?.trim() && title === previousAiTitle.trim()) return true;
	if (sourceName?.trim() && title === sourceName.trim()) return true;
	if (title === LEGACY_AI_TITLE_FALLBACK) return true;
	return GENERATED_TITLE_PATTERN.test(title);
}

export async function generateAiWorkflow(payload: GenerateAiWorkflowPayload) {
	"use workflow";

	const { videoId, userId, generationId } = payload;

	let videoData: VideoData | null;
	try {
		videoData = await validateAndSetProcessing(videoId, generationId);
	} catch (error) {
		await markError(videoId, generationId, "QUEUED");
		throw error;
	}

	if (!videoData) {
		return {
			success: true,
			message: "AI generation claim is no longer current",
		};
	}

	try {
		const transcript = await fetchTranscript(videoId, userId, videoData.video);

		if (!transcript) {
			const skipped = await markSkipped(videoId, generationId);
			return {
				success: true,
				message: skipped
					? "Transcript empty or too short - skipped"
					: "AI generation claim is no longer current",
			};
		}

		const result = await generateWithAi(
			transcript,
			videoData.aiGenerationLanguage,
		);

		const saved = await saveResults(videoId, generationId, videoData, result);
		if (!saved) {
			return {
				success: true,
				message: "AI generation claim is no longer current",
			};
		}
	} catch (error) {
		await markError(videoId, generationId, "PROCESSING");
		throw error;
	}

	return { success: true, message: "AI generation completed successfully" };
}

async function validateAndSetProcessing(
	videoId: string,
	generationId: string,
): Promise<VideoData | null> {
	"use step";

	const query = await db()
		.select({ video: videos, orgSettings: organizations.settings })
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (query.length === 0 || !query[0]?.video) {
		throw new FatalError("Video does not exist");
	}

	const { video } = query[0];
	const metadata = (video.metadata as VideoMetadata) || {};

	if (
		metadata.aiGenerationStatus !== "QUEUED" ||
		metadata.aiGenerationId !== generationId
	) {
		return null;
	}

	if (video.transcriptionStatus !== "COMPLETE") {
		await markSkipped(videoId, generationId, "QUEUED");
		return null;
	}

	if (!isAiConfigured()) {
		throw new FatalError("No AI provider configured");
	}

	const matchingBackfillMarker =
		metadata.aiChapterBackfillGenerationId === generationId;
	if (
		hasValidChapterState(
			metadata.chapters,
			video.duration,
			metadata.chaptersManuallyEdited,
		) &&
		!matchingBackfillMarker
	) {
		await markSkipped(videoId, generationId, "QUEUED");
		return null;
	}

	let processingMetadata = sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiGenerationStatus', 'PROCESSING')`;
	processingMetadata = sql`IF(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiTitle')) = ${LEGACY_AI_TITLE_FALLBACK}, JSON_REMOVE(${processingMetadata}, '$.aiTitle'), ${processingMetadata})`;

	const transitionResult = await db()
		.update(videos)
		.set({
			metadata: processingMetadata,
		})
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				eq(videos.transcriptionStatus, "COMPLETE"),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')) = 'QUEUED'`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationId')) = ${generationId}`,
				...(matchingBackfillMarker
					? [
							sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiChapterBackfillGenerationId')) = ${generationId}`,
						]
					: []),
			),
		);

	if (getAffectedRows(transitionResult) === 0) {
		await markSkipped(videoId, generationId, "QUEUED");
		return null;
	}

	return {
		video,
		metadata,
		aiGenerationLanguage: parseAiGenerationLanguage(
			query[0]?.orgSettings?.aiGenerationLanguage,
		),
	};
}

async function fetchTranscript(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
): Promise<TranscriptData | null> {
	"use step";

	const vtt = await Effect.gen(function* () {
		const [bucket] = yield* Storage.getAccessForVideo(
			decodeStorageVideo(video),
		);
		return yield* bucket.getObject(`${userId}/${videoId}/transcription.vtt`);
	}).pipe(runWorkflowPromise);

	if (Option.isNone(vtt)) {
		return null;
	}

	const segments = parseVttWithTimestamps(vtt.value);
	const text = segments
		.map((s) => s.text)
		.join(" ")
		.trim();

	if (text.length < 10) {
		return null;
	}

	return { segments, text };
}

async function markError(
	videoId: string,
	generationId: string,
	status: "QUEUED" | "PROCESSING",
): Promise<boolean> {
	"use step";

	const result = await db()
		.update(videos)
		.set({
			metadata: restoreMatchingBackfillState(
				sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiGenerationStatus', 'ERROR')`,
				generationId,
			),
		})
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				eq(videos.transcriptionStatus, "COMPLETE"),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationId')) = ${generationId}`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')) = ${status}`,
			),
		);

	return getAffectedRows(result) > 0;
}

async function markSkipped(
	videoId: string,
	generationId: string,
	status: "QUEUED" | "PROCESSING" = "PROCESSING",
): Promise<boolean> {
	"use step";

	const result = await db()
		.update(videos)
		.set({
			metadata: restoreMatchingBackfillState(
				sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiGenerationStatus', 'SKIPPED')`,
				generationId,
			),
		})
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')) = ${status}`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationId')) = ${generationId}`,
			),
		);

	return getAffectedRows(result) > 0;
}

async function generateWithAi(
	transcript: TranscriptData,
	language: AiGenerationLanguage,
): Promise<AiResult> {
	"use step";

	const chunks = chunkTranscriptWithTimestamps(transcript.segments);

	const videoDuration = getVideoDuration(transcript.segments);
	const languageInstruction = getAiLanguageInstruction(language);

	let result: AiResult;
	if (chunks.length === 1) {
		result = await generateSingleChunk(
			transcript.segments,
			videoDuration,
			languageInstruction,
		);
	} else {
		result = await generateMultipleChunks(
			chunks,
			videoDuration,
			languageInstruction,
			transcript.segments,
		);
	}

	result.chapters = validateGeneratedChapters(
		result.chapters ?? [],
		videoDuration,
		transcript.segments,
	);

	return result;
}

export function getAiLanguageInstruction(
	language: AiGenerationLanguage,
): string {
	if (language === AI_GENERATION_LANGUAGE_AUTO) {
		return "Write the title, chapter titles, section analyses, and key points in the same language as the transcript.";
	}

	return `Write the title, chapter titles, section analyses, and key points in ${getAiGenerationLanguageName(language)}.`;
}

export function getAiContentGuidelines(videoDuration: number): {
	summary: string;
	chapters: string;
} {
	let lengthInstruction: string;
	if (videoDuration < 60) {
		lengthInstruction = "Use no more than 35 words and one or two sentences.";
	} else if (videoDuration < 180) {
		lengthInstruction =
			"Aim for 50-90 words in one concise paragraph, but use fewer when that fully communicates the video.";
	} else if (videoDuration < 600) {
		lengthInstruction =
			"Aim for 80-150 words in one concise paragraph, but use fewer when that fully communicates the video.";
	} else if (videoDuration < 1800) {
		lengthInstruction =
			"Aim for 150-250 words. Use short paragraphs or Markdown bullets only when they materially improve clarity.";
	} else {
		lengthInstruction =
			"Aim for 250-400 words. Exceed 400 only when necessary to preserve important decisions, responsibilities, or next steps.";
	}

	const chapterGuidance =
		videoDuration < 120
			? "Create one opening chapter at the first meaningful transcript timestamp. Add another only for a clear topic or phase change; never return an empty chapters array when the transcript contains speech."
			: videoDuration < 600
				? "Create 2-4 chapters when the transcript supports meaningful topic or phase changes. Include an opening chapter near 0 seconds, then mark the major transitions. Do not create chapters for filler or minor UI actions."
				: videoDuration < 1800
					? "Create 4-8 chapters when the transcript supports meaningful topic or phase changes. Include an opening chapter near 0 seconds and cover the major sections across the video. Do not create chapters for filler or minor UI actions."
					: "Create 6-12 chapters when the transcript supports meaningful topic or phase changes. Include an opening chapter near 0 seconds and cover the major sections across the full video so viewers can navigate it. Do not create chapters for filler, minor UI actions, or every transcript segment.";

	return {
		summary: `- Write a standalone summary that lets someone understand the video without watching it.
- State the subject and the speaker's intention first: what the video is about and why it was recorded. If the intention is not explicit, describe only what the transcript supports.
- Then include only the essential explanation, outcomes, decisions, action items, and next steps needed to understand or act on the video.
- Prioritize meaning and useful information over chronological retelling.
- Omit filler, greetings, reactions, apologies, repetition, incidental conversation, minor UI actions, and timestamps unless a timestamp is essential to the viewer.
- Write from the primary speaker's point of view. For a single-person video, use "I" and "my". Use "we" only when the speaker clearly represents a team or several participants share the discussion.
- Never describe the primary voice as "the speaker", "the presenter", "the user", "they", or any similar detached label.
- If multiple speakers need to be distinguished, use names only when the transcript identifies them unambiguously. Otherwise summarize the discussion directly without inventing names or identities.
- Be concise, but never omit information required to understand or act on the video. Do not pad the summary to reach a target length.
- Convert detached narration into first person. For example, write "I review the proposal" instead of "The speaker reviews the proposal". Do not introduce names, projects, or personal details that are not present in the transcript.
- ${lengthInstruction}`,
		chapters: chapterGuidance,
	};
}

function getVideoDuration(segments: VttSegment[]): number {
	if (segments.length === 0) return 0;
	const lastSegment = segments[segments.length - 1];
	return lastSegment ? lastSegment.end : 0;
}

function getChapterCueStarts(
	segments: readonly ChapterTranscriptEvidence[],
	videoDuration: number,
): number[] {
	return [
		...new Set(
			segments
				.filter(
					(segment) =>
						Number.isFinite(segment.start) &&
						segment.start >= 0 &&
						segment.start < videoDuration,
				)
				.map((segment) => segment.start),
		),
	].sort((a, b) => a - b);
}

function clearMatchingBackfillMarker(metadata: SQL, generationId: string): SQL {
	return sql`IF(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiChapterBackfillGenerationId')) = ${generationId}, JSON_REMOVE(${metadata}, '$.aiChapterBackfillGenerationId'), ${metadata})`;
}

function restoreMatchingBackfillState(
	metadata: SQL,
	generationId: string,
): SQL {
	return sql`IF(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiChapterBackfillGenerationId')) = ${generationId}, JSON_REMOVE(JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiGenerationStatus', 'COMPLETE'), '$.aiChapterBackfillGenerationId', '$.aiGenerationId'), ${metadata})`;
}

function buildGeneratedMetadataUpdate(
	metadata: SQL,
	result: AiResult,
	generationId: string,
): SQL {
	if (!Array.isArray(result.chapters)) {
		throw new Error("Cannot mark AI generation complete without chapters");
	}
	let metadataUpdate = metadata;
	const generatedTitle = result.title?.trim();
	if (generatedTitle) {
		metadataUpdate = sql`JSON_SET(${metadataUpdate}, '$.aiTitle', ${generatedTitle})`;
	}
	if (result.chapters) {
		metadataUpdate = setGeneratedAiContent(
			metadataUpdate,
			"chapters",
			result.chapters,
		);
	}
	return clearMatchingBackfillMarker(
		sql`JSON_SET(${metadataUpdate}, '$.aiGenerationStatus', 'COMPLETE')`,
		generationId,
	);
}

async function saveResults(
	videoId: string,
	generationId: string,
	videoData: VideoData,
	result: AiResult,
): Promise<boolean> {
	"use step";

	const { video, metadata } = videoData;
	const generatedTitle = result.title?.trim();
	const currentVideo = await getCurrentVideo(videoId);
	const currentMetadata = currentVideo
		? (currentVideo.metadata as VideoMetadata) || {}
		: metadata;
	const currentTitle = currentVideo?.name ?? video.name;

	const metadataUpdate = buildGeneratedMetadataUpdate(
		sql`COALESCE(${videos.metadata}, JSON_OBJECT())`,
		result,
		generationId,
	);

	const metadataResult = await db()
		.update(videos)
		.set({ metadata: metadataUpdate })
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				eq(videos.transcriptionStatus, "COMPLETE"),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')) = 'PROCESSING'`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationId')) = ${generationId}`,
			),
		);

	if (getAffectedRows(metadataResult) === 0) return false;

	if (
		generatedTitle &&
		shouldReplaceVideoTitle({
			currentTitle,
			previousAiTitle: currentMetadata.aiTitle,
			nextAiTitle: generatedTitle,
			sourceName: currentMetadata.sourceName,
			titleManuallyEdited: currentMetadata.titleManuallyEdited,
		})
	) {
		const titleUpdate = await db()
			.update(videos)
			.set({ name: generatedTitle })
			.where(
				and(
					eq(videos.id, videoId as Video.VideoId),
					eq(videos.transcriptionStatus, "COMPLETE"),
					eq(videos.name, currentTitle),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')) = 'COMPLETE'`,
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationId')) = ${generationId}`,
					sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.titleManuallyEdited')), 'false') <> 'true'`,
				),
			);
		if (getAffectedRows(titleUpdate) > 0) {
			await enqueueVideoStorageNameSync(videoId as Video.VideoId);
		}
	}

	return true;
}

async function getCurrentVideo(
	videoId: string,
): Promise<typeof videos.$inferSelect | null> {
	const [currentVideo] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	return currentVideo ?? null;
}

function parseVttTime(value: string): number | null {
	const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2})[.,](\d{3})$/);
	if (!match) return null;
	return (
		parseInt(match[1] ?? "0", 10) * 3600 +
		parseInt(match[2] ?? "0", 10) * 60 +
		parseInt(match[3] ?? "0", 10) +
		parseInt(match[4] ?? "0", 10) / 1000
	);
}

function parseVttWithTimestamps(vttContent: string): VttSegment[] {
	const lines = vttContent.split("\n");
	const segments: VttSegment[] = [];
	let currentStart = 0;
	let currentEnd = 3;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim() ?? "";
		if (line.includes("-->")) {
			const [startValue, endValue] = line.split("-->");
			const start = parseVttTime(startValue ?? "");
			const end = parseVttTime(endValue?.trim().split(/\s+/)[0] ?? "");
			if (start !== null) currentStart = start;
			if (end !== null) currentEnd = end;
		} else if (
			line &&
			line !== "WEBVTT" &&
			!/^\d+$/.test(line) &&
			!line.includes("-->")
		) {
			segments.push({ start: currentStart, end: currentEnd, text: line });
		}
	}

	return segments;
}

function chunkTranscriptWithTimestamps(segments: VttSegment[]): {
	text: string;
	segments: VttSegment[];
	startTime: number;
	endTime: number;
}[] {
	const chunks: {
		text: string;
		segments: VttSegment[];
		startTime: number;
		endTime: number;
	}[] = [];
	let currentChunk: VttSegment[] = [];
	let currentLength = 0;
	const formatCue = (segment: VttSegment) =>
		`[${Math.floor(segment.start / 60)}:${String(Math.floor(segment.start % 60)).padStart(2, "0")}] ${segment.text}`;

	for (const segment of segments) {
		if (
			currentLength + segment.text.length > MAX_CHARS_PER_CHUNK &&
			currentChunk.length > 0
		) {
			chunks.push({
				text: currentChunk.map(formatCue).join("\n"),
				segments: currentChunk,
				startTime: currentChunk[0]?.start ?? 0,
				endTime: currentChunk[currentChunk.length - 1]?.end ?? 0,
			});
			currentChunk = [];
			currentLength = 0;
		}
		currentChunk.push(segment);
		currentLength += segment.text.length + 1;
	}

	if (currentChunk.length > 0) {
		chunks.push({
			text: currentChunk.map(formatCue).join("\n"),
			segments: currentChunk,
			startTime: currentChunk[0]?.start ?? 0,
			endTime: currentChunk[currentChunk.length - 1]?.end ?? 0,
		});
	}

	return chunks;
}

class InvalidAiOutputError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "InvalidAiOutputError";
	}
}

/**
 * True when the whole provider chain was exhausted and the terminal failure
 * was a fulfilled-but-unusable response rather than a request-level failure.
 */
function failedOnInvalidOutput(error: unknown): boolean {
	return (
		error instanceof AiUnavailableError &&
		error.cause instanceof InvalidAiOutputError
	);
}

export async function callAiApi<T>(
	prompt: string,
	parse: (text: string) => T,
): Promise<T> {
	return runWithAiProviders("generation", async (selection) => {
		const result = await generateText({
			model: selection.model({ jsonRepair: true }),
			prompt,
			maxOutputTokens: selection.defaultMaxOutputTokens,
		});
		// Parse inside the provider loop so an empty, malformed, or truncated
		// fulfilled response falls through to the next provider too.
		try {
			return parse(result.text);
		} catch (error) {
			throw new InvalidAiOutputError(
				error instanceof Error ? error.message : String(error),
				{ cause: error },
			);
		}
	});
}

function cleanJsonResponse(content: string): string {
	if (content.includes("```json")) {
		return content.replace(/```json\s*/g, "").replace(/```\s*/g, "");
	}
	if (content.includes("```")) {
		return content.replace(/```\s*/g, "");
	}
	return content;
}

function extractJsonObject(content: string): string {
	const cleanedContent = cleanJsonResponse(content).trim();
	const start = cleanedContent.indexOf("{");
	if (start < 0) {
		throw new Error("AI response did not contain a JSON object");
	}

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < cleanedContent.length; i++) {
		const character = cleanedContent[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}

		if (character === '"') {
			inString = true;
		} else if (character === "{") {
			depth += 1;
		} else if (character === "}") {
			depth -= 1;
			if (depth === 0) {
				return cleanedContent.slice(start, i + 1);
			}
		}
	}

	throw new Error("AI response contained an incomplete JSON object");
}

async function generateSingleChunk(
	segments: VttSegment[],
	videoDuration: number,
	languageInstruction: string,
): Promise<AiResult> {
	const transcriptWithTimestamps = segments
		.map(
			(s) =>
				`[${Math.floor(s.start / 60)}:${String(s.start % 60).padStart(2, "0")}] ${s.text}`,
		)
		.join("\n");
	const contentGuidelines = getAiContentGuidelines(videoDuration);

	const prompt = `You are Cap AI, an expert at turning video transcripts into useful navigation chapters and a concise title.

The video is ${videoDuration} seconds long (${Math.floor(videoDuration / 60)}:${String(Math.floor(videoDuration % 60)).padStart(2, "0")} total). Analyze this timestamped transcript and provide JSON:
{
  "title": "string (concise but descriptive title that captures the main topic)",
  "chapters": [{"title": "string (descriptive chapter title)", "start": number (seconds from start)}]
}

Chapter requirements:
${contentGuidelines.chapters}

Additional requirements:
- ${languageInstruction}
- Keep JSON property names exactly as shown.
- Include specific names, numbers, decisions, and conclusions in chapter titles only when they help someone navigate the video.
- IMPORTANT: All chapter "start" values MUST be between 0 and ${videoDuration} seconds. Use the timestamps from the transcript to determine accurate chapter start times.
- Return at least one opening chapter near the first spoken timestamp when the transcript contains meaningful speech.

Return ONLY valid JSON without any markdown formatting or code blocks.
Transcript:
${transcriptWithTimestamps}`;

	const parsed = await callAiApi(prompt, parseAiResponse);
	let chapters = parsed.chapters ?? [];
	const minimumChapterCount = getRequiredChapterSynthesisCount(
		videoDuration,
		chapters,
		segments,
	);

	if (minimumChapterCount > 0) {
		const chapterCueStarts = getChapterCueStarts(segments, videoDuration);
		const chapterPrompt = `You are Cap AI, creating navigation chapters from a timestamped transcript for a ${videoDuration}-second video.

Allowed chapter cue starts (seconds): ${chapterCueStarts.join(", ")}

The first analysis returned only a generic opening chapter. Return at least ${minimumChapterCount} distinct, useful chapters that cover supported topic or phase changes across the full recording. Use only the allowed cue starts and do not invent topics.

Provide JSON in this format:
{
  "chapters": [{"title": "string (specific descriptive title)", "start": number (seconds from video start)}]
}

- ${contentGuidelines.chapters}
- Return ONLY valid JSON without markdown.
Transcript:
${transcriptWithTimestamps}`;

		chapters = await callAiApi(chapterPrompt, (text) =>
			parseChapterSynthesis(text, minimumChapterCount, videoDuration, segments),
		);
	}

	return {
		...parsed,
		chapters: validateGeneratedChapters(chapters, videoDuration, segments),
	};
}

async function generateMultipleChunks(
	chunks: {
		text: string;
		segments: VttSegment[];
		startTime: number;
		endTime: number;
	}[],
	videoDuration: number,
	languageInstruction: string,
	transcriptSegments: VttSegment[],
): Promise<AiResult> {
	const chunkSummaries: {
		summary: string;
		keyPoints: string[];
		chapters: { title: string; start: number }[];
		startTime: number;
		endTime: number;
	}[] = [];
	const contentGuidelines = getAiContentGuidelines(videoDuration);

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (!chunk) continue;

		const chunkPrompt = `You are Cap AI, analyzing one section of a video for a later final summary. This is section ${i + 1} of ${chunks.length} from a video that is ${videoDuration} seconds long (${Math.floor(videoDuration / 60)}:${String(Math.floor(videoDuration % 60)).padStart(2, "0")} total). This section covers timestamp ${Math.floor(chunk.startTime / 60)}:${String(chunk.startTime % 60).padStart(2, "0")} to ${Math.floor(chunk.endTime / 60)}:${String(chunk.endTime % 60).padStart(2, "0")}.

Extract only the information needed to understand this section's contribution to the full video and provide JSON:
{
  "summary": "string (concise factual notes about the subject, intention, essential explanation, outcomes, decisions, or next steps in this section)",
  "keyPoints": ["string (essential key point or takeaway, or an empty array when there is none)", ...],
  "chapters": [{"title": "string (descriptive title for this topic/section)", "start": number (seconds from video start)}]
}

- Preserve specific names, numbers, decisions, responsibilities, and conclusions that matter to the final summary.
- Omit filler, greetings, reactions, apologies, repetition, incidental conversation, and minor UI actions.
- Do not narrate the transcript chronologically or pad the section analysis.
- ${contentGuidelines.chapters}
- ${languageInstruction}
- Keep JSON property names exactly as shown.
IMPORTANT: All chapter "start" values MUST be at least ${chunk.startTime} and strictly less than ${chunk.endTime} seconds, and each start MUST align within one second of one of the timestamped transcript cues above. The total video is only ${videoDuration} seconds long.
Return ONLY valid JSON without any markdown formatting or code blocks.
Transcript section:
${chunk.text}`;

		try {
			const parsed = await callAiApi(chunkPrompt, (content) => {
				const parsed = parseChunkAnalysis(content);
				validateChapterStartsInSection(
					parsed.chapters,
					chunk,
					videoDuration,
					chunk.segments,
				);
				return parsed;
			});
			chunkSummaries.push({
				...parsed,
				startTime: chunk.startTime,
				endTime: chunk.endTime,
			});
		} catch (error) {
			// A chunk is skipped only when every provider returned unusable
			// JSON; a request-level chain failure still fails the workflow.
			if (!failedOnInvalidOutput(error)) throw error;
		}
	}

	if (chunkSummaries.length === 0) {
		throw new Error("No usable chunk analysis was produced");
	}

	const chapterCandidates = chunkSummaries.flatMap((c) => c.chapters);
	let allChapters = clampChapters(chapterCandidates, videoDuration);

	const sectionDetails = chunkSummaries
		.map((c, i) => {
			const timeRange = `${Math.floor(c.startTime / 60)}:${String(c.startTime % 60).padStart(2, "0")} - ${Math.floor(c.endTime / 60)}:${String(c.endTime % 60).padStart(2, "0")}`;
			const keyPointsList =
				c.keyPoints.length > 0 ? `\nKey points: ${c.keyPoints.join("; ")}` : "";
			return `Section ${i + 1} (${timeRange}):\n${c.summary}${keyPointsList}`;
		})
		.join("\n\n");
	const minimumChapterCount = getRequiredChapterSynthesisCount(
		videoDuration,
		chapterCandidates,
		transcriptSegments,
	);

	if (minimumChapterCount > 0) {
		const chapterCueStarts = getChapterCueStarts(
			transcriptSegments,
			videoDuration,
		);
		const chapterCueGuidance =
			chapterCueStarts.length > 0
				? `Allowed chapter cue starts (seconds): ${chapterCueStarts.join(", ")}`
				: "No eligible transcript cue starts are available.";
		const chapterPrompt = `You are Cap AI, creating navigation chapters from timestamped section analyses for a ${videoDuration}-second video.

Section analyses:
${sectionDetails}

${chapterCueGuidance}

The analyses contain distinct chapter candidates that indicate multiple meaningful sections. Return at least ${minimumChapterCount} distinct, useful chapters that cover the supported topic or phase changes across the video. Reuse accurate section timestamps and do not invent topics not present in the analyses.

Provide JSON in this format:
{
  "chapters": [{"title": "string (specific descriptive title)", "start": number (seconds from video start)}]
}

- Include an opening chapter near 0 seconds.
- All chapter starts must be between 0 and ${videoDuration} seconds.
- Return ONLY valid JSON without markdown formatting or code blocks.`;

		allChapters = await callAiApi(chapterPrompt, (text) => {
			const chapters = parseChapterSynthesis(
				text,
				minimumChapterCount,
				videoDuration,
				transcriptSegments,
			);
			validateChapterStartsInSection(
				chapters,
				{ startTime: 0, endTime: videoDuration },
				videoDuration,
				transcriptSegments,
			);
			return chapters;
		});
	}

	const finalPrompt = `You are Cap AI, creating a concise title from timestamped section analyses.

Section analyses:
${sectionDetails}

Provide JSON in the following format:
{
  "title": "string (concise but descriptive title that captures the main topic/purpose)"
}

Additional requirements:
- ${languageInstruction}
- Keep JSON property names exactly as shown.
- Do not return a summary or any other public content.
Return ONLY valid JSON without any markdown formatting or code blocks.`;

	try {
		const parsed = await callAiApi(finalPrompt, parseFinalTitle);
		return {
			title: parsed.title,
			chapters: allChapters,
		};
	} catch (error) {
		if (!failedOnInvalidOutput(error)) throw error;
		return {
			title: "Video Summary",
			chapters: allChapters,
		};
	}
}

// Like parseAiResponse, these throw on missing or empty required fields —
// inside the provider loop that sends the attempt to the next provider
// instead of completing the workflow with an empty analysis.
export function parseChunkAnalysis(content: string): {
	summary: string;
	keyPoints: string[];
	chapters: { title: string; start: number }[];
} {
	const parsed = JSON.parse(extractJsonObject(content)) as {
		summary?: unknown;
		keyPoints?: unknown;
		chapters?: unknown;
	};
	if (typeof parsed.summary !== "string" || !parsed.summary.trim()) {
		throw new Error("AI response did not contain a valid section summary");
	}
	let chapters: { title: string; start: number }[] = [];
	if (parsed.chapters !== undefined) {
		if (!Array.isArray(parsed.chapters)) {
			throw new Error("AI response did not contain a valid chapters array");
		}
		chapters = parsed.chapters.map((chapter, index) => {
			if (
				typeof chapter !== "object" ||
				chapter === null ||
				typeof chapter.start !== "number" ||
				!Number.isFinite(chapter.start) ||
				chapter.start < 0 ||
				typeof chapter.title !== "string" ||
				!chapter.title.trim()
			) {
				throw new Error(
					`AI response contained an invalid chapter at index ${index}`,
				);
			}
			return { title: chapter.title.trim(), start: chapter.start };
		});
	}
	return {
		summary: parsed.summary,
		keyPoints: Array.isArray(parsed.keyPoints)
			? parsed.keyPoints.filter(
					(keyPoint): keyPoint is string => typeof keyPoint === "string",
				)
			: [],
		chapters,
	};
}

export function parseFinalTitle(content: string): { title: string } {
	const parsed = JSON.parse(extractJsonObject(content)) as {
		title?: unknown;
	};
	if (typeof parsed.title !== "string" || !parsed.title.trim()) {
		throw new Error("AI response did not contain a valid title");
	}
	return { title: parsed.title.trim() };
}

export function parseChapterSynthesis(
	content: string,
	minimumChapterCount: number,
	videoDuration?: number,
	transcriptCues: readonly ChapterTranscriptEvidence[] = [],
): { title: string; start: number }[] {
	const parsed = JSON.parse(extractJsonObject(content)) as {
		chapters?: unknown;
	};
	if (parsed.chapters === undefined) {
		if (minimumChapterCount > 0) {
			throw new Error(
				`AI response did not contain at least ${minimumChapterCount} useful chapters`,
			);
		}
		return [];
	}
	if (!Array.isArray(parsed.chapters)) {
		throw new Error("AI response did not contain a valid chapters array");
	}
	const chapters = parsed.chapters.map((chapter, index) => {
		if (
			typeof chapter !== "object" ||
			chapter === null ||
			typeof chapter.title !== "string" ||
			!chapter.title.trim() ||
			typeof chapter.start !== "number" ||
			!Number.isFinite(chapter.start) ||
			chapter.start < 0 ||
			(typeof videoDuration === "number" && chapter.start >= videoDuration)
		) {
			throw new Error(
				`AI response contained an invalid chapter at index ${index}`,
			);
		}
		return { title: chapter.title.trim(), start: chapter.start };
	});
	validateChapterOrder(chapters);
	if (typeof videoDuration === "number" && transcriptCues.length > 0) {
		validateChapterStartsInSection(
			chapters,
			{ startTime: 0, endTime: videoDuration },
			videoDuration,
			transcriptCues,
		);
	}
	const usableChapters =
		typeof videoDuration === "number"
			? clampChapters(chapters, videoDuration)
			: chapters.sort((a, b) => a.start - b.start);

	if (usableChapters.length < minimumChapterCount) {
		throw new Error(
			`AI response did not contain at least ${minimumChapterCount} useful chapters`,
		);
	}
	const distinctTitles = new Set(
		usableChapters.map((chapter) => chapter.title.trim().toLocaleLowerCase()),
	);
	if (distinctTitles.size < minimumChapterCount) {
		throw new Error(
			`AI response did not contain at least ${minimumChapterCount} distinct chapter titles`,
		);
	}

	return usableChapters;
}

export function parseAiResponse(content: string): AiResult {
	const data = JSON.parse(extractJsonObject(content)) as {
		title?: unknown;
		chapters?: unknown;
	};
	if (typeof data.title !== "string" || !data.title.trim()) {
		throw new Error("AI response did not contain a valid title");
	}
	if (!Array.isArray(data.chapters)) {
		throw new Error("AI response did not contain a valid chapters array");
	}

	const chapters = data.chapters.map((chapter, index) => {
		if (
			typeof chapter !== "object" ||
			chapter === null ||
			typeof chapter.start !== "number" ||
			!Number.isFinite(chapter.start) ||
			chapter.start < 0 ||
			typeof chapter.title !== "string" ||
			!chapter.title.trim()
		) {
			throw new Error(
				`AI response contained an invalid chapter at index ${index}`,
			);
		}
		return { title: chapter.title.trim(), start: chapter.start };
	});

	return {
		title: data.title.trim(),
		chapters,
	};
}

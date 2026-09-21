"use client";

import { Button } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { editAiContent } from "@/actions/videos/edit-ai-content";
import type { VideoStatusResult } from "@/actions/videos/get-status";
import {
	type AiContent,
	chaptersEqual,
	formatChapterTime,
	MAX_CHAPTER_TITLE_LENGTH,
	MAX_CHAPTERS,
	MAX_SUMMARY_LENGTH,
	normalizeAiContent,
	parseChapterTime,
	validateAiContent,
} from "@/lib/ai-content";

export type SummaryEditingState = "clean" | "dirty" | "saving";
export type SummarySaveRequest = () => Promise<boolean>;

const AUTOSAVE_DELAY_MS = 700;
const DRAFT_STORAGE_PREFIX = "cap:summary-draft:";
const DRAFT_TTL_MS = 24 * 60 * 60 * 1_000;

type ChapterFormValue = {
	title: string;
	time: string;
	originalStart?: number;
};

type StoredDraft = {
	version: 2;
	updatedAt: number;
	baselineFingerprint: string;
	summary: string;
	chapters: ChapterFormValue[];
};

const contentEqual = (left: AiContent, right: AiContent) => {
	const normalizedLeft = normalizeAiContent(left);
	const normalizedRight = normalizeAiContent(right);
	return (
		normalizedLeft.summary === normalizedRight.summary &&
		chaptersEqual(normalizedLeft.chapters, normalizedRight.chapters)
	);
};

const draftStorageKey = (videoId: Video.VideoId) =>
	`${DRAFT_STORAGE_PREFIX}${videoId}`;

const contentFingerprint = (content: AiContent) => {
	const serialized = JSON.stringify(normalizeAiContent(content));
	let hash = 2_166_136_261;
	for (let index = 0; index < serialized.length; index++) {
		hash ^= serialized.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return `${serialized.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

const readDraft = (
	videoId: Video.VideoId,
	baseline: AiContent,
): StoredDraft | null => {
	if (typeof window === "undefined") return null;
	const key = draftStorageKey(videoId);
	try {
		// Remove drafts written by the previous origin-wide persistence scheme.
		localStorage.removeItem(key);
		const parsed = JSON.parse(
			sessionStorage.getItem(key) ?? "null",
		) as Partial<StoredDraft> | null;
		const age = Date.now() - (parsed?.updatedAt ?? Number.NaN);
		const valid =
			parsed?.version === 2 &&
			typeof parsed.updatedAt === "number" &&
			age >= 0 &&
			age <= DRAFT_TTL_MS &&
			typeof parsed.summary === "string" &&
			Array.isArray(parsed.chapters) &&
			parsed.chapters.every(
				(chapter) =>
					typeof chapter?.title === "string" &&
					typeof chapter.time === "string" &&
					(chapter.originalStart === undefined ||
						typeof chapter.originalStart === "number"),
			) &&
			typeof parsed.baselineFingerprint === "string" &&
			parsed.baselineFingerprint === contentFingerprint(baseline);
		if (valid) return parsed as StoredDraft;
		sessionStorage.removeItem(key);
	} catch {
		// Ignore malformed data or unavailable storage.
	}
	return null;
};

const writeDraft = (
	videoId: Video.VideoId,
	baseline: AiContent,
	summary: string,
	chapters: ChapterFormValue[],
) => {
	try {
		sessionStorage.setItem(
			draftStorageKey(videoId),
			JSON.stringify({
				version: 2,
				updatedAt: Date.now(),
				baselineFingerprint: contentFingerprint(baseline),
				summary,
				chapters,
			} satisfies StoredDraft),
		);
	} catch {
		// Saving to the server remains available when storage is unavailable.
	}
};

const clearDraft = (videoId: Video.VideoId) => {
	try {
		const key = draftStorageKey(videoId);
		sessionStorage.removeItem(key);
		localStorage.removeItem(key);
	} catch {
		// Ignore unavailable storage.
	}
};

export function SummaryEditor({
	videoId,
	initialContent,
	duration,
	onEditingStateChange,
	onSaveRequestChange,
}: {
	videoId: Video.VideoId;
	initialContent: AiContent;
	duration?: number | null;
	onEditingStateChange?: (state: SummaryEditingState) => void;
	onSaveRequestChange?: (request: SummarySaveRequest | null) => void;
}) {
	const queryClient = useQueryClient();
	const id = useId();
	const expectedRef = useRef(initialContent);
	const [expected, setExpected] = useState(initialContent);
	const normalizedExpected = normalizeAiContent(expected);
	const [summary, setSummary] = useState(initialContent.summary);
	const nextId = useRef(initialContent.chapters.length);
	const [chapters, setChapters] = useState<
		{ id: number; title: string; time: string; originalStart?: number }[]
	>(() =>
		initialContent.chapters.map((chapter, index) => ({
			id: index,
			title: chapter.title,
			time: formatChapterTime(chapter.start),
			originalStart: chapter.start,
		})),
	);
	const [isSaving, setIsSaving] = useState(false);
	const savePromiseRef = useRef<Promise<boolean> | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [hasSaved, setHasSaved] = useState(false);
	const summaryRef = useRef<HTMLTextAreaElement>(null);
	const value: AiContent = {
		summary: summary.trim(),
		chapters: chapters.map((chapter) => ({
			title: chapter.title.trim(),
			start: chapter.originalStart ?? parseChapterTime(chapter.time),
		})),
	};
	const dirty =
		value.summary !== normalizedExpected.summary ||
		!chaptersEqual(value.chapters, normalizedExpected.chapters);
	const validationError = validateAiContent(value, duration);
	const autosaveValue = JSON.stringify(value);
	const valueRef = useRef(value);
	valueRef.current = value;
	const formValueRef = useRef({ summary, chapters });
	formValueRef.current = { summary, chapters };

	useEffect(() => {
		const draft = readDraft(videoId, expectedRef.current);
		if (draft) {
			setSummary(draft.summary);
			setChapters(
				draft.chapters.map((chapter, index) => ({ ...chapter, id: index })),
			);
			nextId.current = draft.chapters.length;
		}
	}, [videoId]);

	useEffect(() => {
		summaryRef.current?.focus();
	}, []);

	useEffect(() => {
		onEditingStateChange?.(isSaving ? "saving" : dirty ? "dirty" : "clean");
		return () => onEditingStateChange?.("clean");
	}, [dirty, isSaving, onEditingStateChange]);

	const save = useCallback(() => {
		if (savePromiseRef.current) return savePromiseRef.current;

		const promise = (async () => {
			setIsSaving(true);
			setError(null);
			try {
				const queryKey = ["videoStatus", videoId];
				while (true) {
					const nextValue = valueRef.current;
					const normalizedBaseline = normalizeAiContent(expectedRef.current);
					const hasChanges =
						nextValue.summary !== normalizedBaseline.summary ||
						!chaptersEqual(nextValue.chapters, normalizedBaseline.chapters);
					if (validateAiContent(nextValue, duration)) return false;
					if (!hasChanges) return true;

					await queryClient.cancelQueries({ queryKey });
					const result = await editAiContent(videoId, {
						value: nextValue,
						expected: expectedRef.current,
					});
					if (!result.success) {
						setError(result.message);
						void queryClient.invalidateQueries({ queryKey });
						return false;
					}
					expectedRef.current = result.data;
					setExpected(result.data);
					setHasSaved(true);
					if (contentEqual(valueRef.current, result.data)) {
						clearDraft(videoId);
					} else {
						writeDraft(
							videoId,
							result.data,
							formValueRef.current.summary,
							formValueRef.current.chapters,
						);
					}
					await queryClient.cancelQueries({ queryKey });
					queryClient.setQueryData<VideoStatusResult>(queryKey, (current) =>
						current ? { ...current, ...result.data } : current,
					);
					void queryClient.invalidateQueries({ queryKey });
				}
			} catch {
				setError("Couldn't save your changes. Please try again.");
				return false;
			} finally {
				setIsSaving(false);
			}
		})();

		savePromiseRef.current = promise;
		void promise.finally(() => {
			if (savePromiseRef.current === promise) savePromiseRef.current = null;
		});
		return promise;
	}, [duration, queryClient, videoId]);

	useEffect(() => {
		onSaveRequestChange?.(save);
		return () => onSaveRequestChange?.(null);
	}, [onSaveRequestChange, save]);

	useEffect(() => {
		if (!dirty) {
			clearDraft(videoId);
			return;
		}
		writeDraft(videoId, expectedRef.current, summary, chapters);
	}, [chapters, dirty, summary, videoId]);

	useEffect(() => {
		// Restart the debounce whenever any summary or chapter field changes.
		void autosaveValue;
		if (!dirty || validationError || error) return;
		const timeout = window.setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
		return () => window.clearTimeout(timeout);
	}, [autosaveValue, dirty, error, save, validationError]);

	useEffect(() => {
		if (!dirty) return;
		const handleUnload = (event: BeforeUnloadEvent) => {
			writeDraft(
				videoId,
				expectedRef.current,
				formValueRef.current.summary,
				formValueRef.current.chapters,
			);
			void save();
			event.preventDefault();
		};
		window.addEventListener("beforeunload", handleUnload);
		return () => window.removeEventListener("beforeunload", handleUnload);
	}, [dirty, save, videoId]);

	return (
		<div className="flex flex-col h-full min-h-0">
			<div className="overflow-y-auto flex-1 p-4 space-y-6">
				<div className="space-y-2">
					<label
						htmlFor={`${id}-summary`}
						className="block text-sm font-medium text-gray-12"
					>
						Summary
					</label>
					<p id={`${id}-summary-help`} className="text-xs text-gray-10">
						Edit the summary below. Markdown formatting is supported.
					</p>
					<textarea
						ref={summaryRef}
						id={`${id}-summary`}
						aria-describedby={`${id}-summary-help`}
						value={summary}
						onChange={(event) => {
							setError(null);
							setSummary(event.target.value);
						}}
						onBlur={() => void save()}
						maxLength={MAX_SUMMARY_LENGTH}
						rows={10}
						className="w-full min-h-48 p-3 text-sm leading-relaxed text-gray-12 bg-gray-1 border border-gray-5 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-blue-9"
					/>
				</div>
				<fieldset className="space-y-3">
					<legend className="text-sm font-medium text-gray-12">Chapters</legend>
					<p id={`${id}-time-help`} className="text-xs text-gray-10">
						Use MM:SS or HH:MM:SS. Keep timestamps in order.
					</p>
					{chapters.map((chapter, index) => (
						<div key={chapter.id} className="flex gap-2 items-start">
							<div className="w-24 shrink-0">
								<label htmlFor={`${id}-time-${chapter.id}`} className="sr-only">
									Chapter {index + 1} timestamp
								</label>
								<input
									id={`${id}-time-${chapter.id}`}
									aria-describedby={`${id}-time-help`}
									value={chapter.time}
									onChange={(event) => {
										setError(null);
										setChapters((current) =>
											current.map((item) =>
												item.id === chapter.id
													? {
															...item,
															time: event.target.value,
															originalStart: undefined,
														}
													: item,
											),
										);
									}}
									placeholder="00:00"
									className="w-full px-2 py-2 text-sm font-mono bg-gray-1 border border-gray-5 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-9"
								/>
							</div>
							<div className="flex-1 min-w-0">
								<label
									htmlFor={`${id}-title-${chapter.id}`}
									className="sr-only"
								>
									Chapter {index + 1} title
								</label>
								<input
									id={`${id}-title-${chapter.id}`}
									value={chapter.title}
									onChange={(event) => {
										setError(null);
										setChapters((current) =>
											current.map((item) =>
												item.id === chapter.id
													? { ...item, title: event.target.value }
													: item,
											),
										);
									}}
									maxLength={MAX_CHAPTER_TITLE_LENGTH}
									placeholder="Chapter title"
									className="w-full px-2 py-2 text-sm bg-gray-1 border border-gray-5 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-9"
								/>
							</div>
							<button
								type="button"
								aria-label={`Remove chapter ${index + 1}`}
								onClick={() => {
									setError(null);
									setChapters((current) =>
										current.filter((item) => item.id !== chapter.id),
									);
								}}
								className="p-2 text-gray-10 rounded-lg hover:bg-gray-3 hover:text-red-9 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
							>
								<Trash2 className="size-4" />
							</button>
						</div>
					))}
					<Button
						type="button"
						variant="gray"
						size="sm"
						disabled={chapters.length >= MAX_CHAPTERS}
						onClick={() => {
							setError(null);
							const chapterId = nextId.current++;
							setChapters((current) => [
								...current,
								{
									id: chapterId,
									title: "",
									time: current.length ? "" : "00:00",
									originalStart: undefined,
								},
							]);
							requestAnimationFrame(() =>
								document.getElementById(`${id}-title-${chapterId}`)?.focus(),
							);
						}}
					>
						<Plus className="mr-1.5 size-4" /> Add chapter
					</Button>
				</fieldset>
			</div>
			<div className="shrink-0 p-4 space-y-2 border-t border-gray-4 bg-gray-1">
				{(error || validationError) && (
					<p role="alert" className="text-xs text-red-10">
						Error: {error || validationError}
					</p>
				)}
				<output aria-live="polite" className="text-xs text-gray-10">
					{isSaving || (dirty && !error && !validationError)
						? "Saving…"
						: error || validationError
							? "Autosave paused"
							: hasSaved
								? "Saved"
								: "All changes saved"}
				</output>
			</div>
		</div>
	);
}

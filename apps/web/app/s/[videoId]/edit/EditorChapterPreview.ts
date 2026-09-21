"use client";

import type { VideoEditSpec } from "@cap/database/types";
import { createElement, Fragment, useEffect, useMemo, useState } from "react";
import {
	mapOutputChaptersToSource,
	mapOutputChapterTimeToSourceTime,
	projectSourceChaptersToOutput,
	type VideoChapter,
} from "@/lib/video-edits";
import { formatChaptersAsVTT } from "../_components/utils/transcript-utils";

export function useEditorChapterPreview({
	chapters,
	initialEditSpec,
	editSpec,
}: {
	chapters: readonly VideoChapter[];
	initialEditSpec: VideoEditSpec;
	editSpec: VideoEditSpec;
}) {
	const sourceChapters = useMemo(
		() => mapOutputChaptersToSource(chapters, initialEditSpec),
		[chapters, initialEditSpec],
	);
	const projectedChapters = useMemo(
		() => projectSourceChaptersToOutput(sourceChapters, editSpec),
		[editSpec, sourceChapters],
	);
	const playbackChapters = useMemo(
		() =>
			projectedChapters.flatMap((chapter) => {
				const sourceTime = mapOutputChapterTimeToSourceTime(
					chapter.start,
					editSpec,
				);
				return sourceTime === null ? [] : [{ ...chapter, start: sourceTime }];
			}),
		[editSpec, projectedChapters],
	);
	const [chaptersUrl, setChaptersUrl] = useState<string | null>(null);

	useEffect(() => {
		if (playbackChapters.length === 0) {
			setChaptersUrl(null);
			return;
		}
		const url = URL.createObjectURL(
			new Blob([formatChaptersAsVTT(playbackChapters)], { type: "text/vtt" }),
		);
		setChaptersUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [playbackChapters]);

	return { chaptersUrl, playbackChapters, projectedChapters };
}

export function EditorChapterMarkers({
	chapters,
	outputDuration,
}: {
	chapters: readonly VideoChapter[];
	outputDuration: number;
}) {
	if (outputDuration <= 0) return null;
	return createElement(
		Fragment,
		null,
		...chapters.map((chapter, index) => {
			if (chapter.start <= 0 || chapter.start >= outputDuration) return null;
			return createElement("span", {
				key: `${chapter.title}-${chapter.start}-${index}`,
				role: "img",
				title: chapter.title,
				"aria-label": `Chapter: ${chapter.title}`,
				className:
					"pointer-events-none absolute inset-y-0 z-[15] w-px -translate-x-1/2 bg-white/70 shadow-[0_0_2px_rgba(0,0,0,0.8)]",
				style: {
					left: `${Math.min(100, Math.max(0, (chapter.start / outputDuration) * 100))}%`,
				},
			});
		}),
	);
}

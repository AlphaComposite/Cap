export type RevisionMetadataSnapshot = {
	captionsVtt: string;
	chapters: { title: string; start: number }[];
	summaryStatus: "persisted";
	summaryDerived: false;
	summaryText: string | null;
	thumbnail: "source-zero" | "seg0-first-frame" | "unavailable";
	durationSeconds: number;
};

export function pageMetadataForRevision(input: {
	snapshot: RevisionMetadataSnapshot | null;
	liveMetadata?: {
		chapters?: { title: string; start: number }[];
		summary?: string | null;
	} | null;
}): {
	chapters: { title: string; start: number }[];
	summaryText: string | null;
	summaryDerived: false;
	summaryStatus: "persisted";
	thumbnail: RevisionMetadataSnapshot["thumbnail"];
	captionsVtt: string | null;
	durationSeconds: number | null;
} {
	void input.liveMetadata;
	if (!input.snapshot) {
		return {
			chapters: [],
			summaryText: null,
			summaryDerived: false,
			summaryStatus: "persisted",
			thumbnail: "unavailable",
			captionsVtt: null,
			durationSeconds: null,
		};
	}
	return {
		chapters: input.snapshot.chapters,
		summaryText: input.snapshot.summaryText,
		summaryDerived: false,
		summaryStatus: "persisted",
		thumbnail: input.snapshot.thumbnail,
		captionsVtt: input.snapshot.captionsVtt,
		durationSeconds: input.snapshot.durationSeconds,
	};
}

export function finishMetadataSnapshot(input: {
	captionsVtt: string;
	chapters: { title: string; start: number }[];
	summaryText: string | null;
	thumbnail: RevisionMetadataSnapshot["thumbnail"];
	durationSeconds: number;
}): RevisionMetadataSnapshot {
	return {
		captionsVtt: input.captionsVtt,
		chapters: input.chapters,
		summaryStatus: "persisted",
		summaryDerived: false,
		summaryText: input.summaryText,
		thumbnail: input.thumbnail,
		durationSeconds: input.durationSeconds,
	};
}

export function revisionPageChapters(input: {
	snapshotChapters: { title: string; start: number }[] | null;
	snapshotDuration: number | null;
	liveChapters: { title: string; start: number }[] | null;
	liveDuration: number | null;
}): { title: string; start: number }[] {
	const snapshot = input.snapshotChapters ?? [];
	if (
		!input.liveChapters ||
		input.snapshotDuration == null ||
		input.liveDuration == null ||
		Math.abs(input.liveDuration - input.snapshotDuration) > 0.001
	) {
		return snapshot;
	}
	return input.liveChapters;
}

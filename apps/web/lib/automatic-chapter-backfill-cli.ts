import {
	type AutomaticChapterBackfillObservedState,
	type AutomaticChapterBackfillRow,
	parseAutomaticChapterBackfillArgs,
	runAutomaticChapterBackfill,
} from "@/lib/automatic-chapter-backfill";

type BackfillDependencies = {
	listVideos: (options: {
		videoId?: string;
		limit: number;
	}) => Promise<AutomaticChapterBackfillRow[]>;
	startGeneration: (
		videoId: string,
		ownerId: string,
		observedState: AutomaticChapterBackfillObservedState,
	) => Promise<{ success: boolean; message: string }>;
};

export async function executeAutomaticChapterBackfillCli(
	argv: string[],
	dependencies: BackfillDependencies,
	write: (line: string) => void,
): Promise<number> {
	const options = parseAutomaticChapterBackfillArgs(argv);
	const output = await runAutomaticChapterBackfill(options, dependencies);
	for (const record of output) write(JSON.stringify(record));
	return output.length;
}

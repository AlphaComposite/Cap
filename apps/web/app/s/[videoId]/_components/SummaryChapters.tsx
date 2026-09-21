import ReactMarkdown from "react-markdown";
import { formatTimeMinutes } from "./utils/transcript-utils";

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

interface SummaryChaptersProps {
	isSummaryDisabled: boolean;
	areChaptersDisabled: boolean;
	handleSeek: (time: number) => void;
	aiData: {
		title: string | null;
		summary: string | null;
		chapters:
			| {
					title: string;
					start: number;
			  }[]
			| null;
		aiGenerationStatus: AiGenerationStatus | null;
	};
	aiLoading: boolean;
}

const SummaryChapters = ({
	isSummaryDisabled,
	areChaptersDisabled,
	handleSeek,
	aiData,
	aiLoading,
}: SummaryChaptersProps) => {
	const hasSummary = !isSummaryDisabled && !!aiData?.summary;
	const hasChapters =
		!areChaptersDisabled &&
		Array.isArray(aiData?.chapters) &&
		aiData.chapters.length > 0;

	if (aiLoading || (!hasSummary && !hasChapters)) return null;

	return (
		<div className="mx-auto w-full max-w-3xl px-1 pb-10 pt-5 sm:px-4 sm:pb-14 sm:pt-8 lg:px-8">
			{hasSummary && (
				<section data-testid="public-summary" className="space-y-3">
					<h2 className="text-xl font-semibold tracking-tight text-gray-12 sm:text-2xl">
						Summary
					</h2>
					<div className="prose prose-sm prose-gray max-w-none text-[15px] leading-7 text-gray-11 prose-p:my-2 prose-ul:my-2 prose-li:my-0 prose-strong:text-gray-12">
						<ReactMarkdown>{aiData.summary}</ReactMarkdown>
					</div>
				</section>
			)}

			{hasChapters && (
				<section
					data-testid="public-chapters"
					className={hasSummary ? "mt-10 border-t border-gray-4 pt-8" : ""}
				>
					<h2 className="mb-4 text-xl font-semibold tracking-tight text-gray-12 sm:text-2xl">
						Chapters
					</h2>
					<div className="divide-y divide-gray-4">
						{aiData.chapters?.map((chapter) => (
							<button
								type="button"
								key={chapter.start}
								className="group grid w-full grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-3 py-3 text-left text-gray-12 transition-colors hover:text-blue-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2 sm:py-3.5"
								onClick={() => handleSeek(chapter.start)}
							>
								<span className="font-mono text-xs font-medium text-blue-10">
									{formatTimeMinutes(chapter.start)}
								</span>
								<span className="min-w-0 text-sm font-medium sm:text-[15px]">
									{chapter.title}
								</span>
							</button>
						))}
					</div>
				</section>
			)}
		</div>
	);
};

export default SummaryChapters;

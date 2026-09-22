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
		<div className="mx-auto w-full max-w-3xl px-1 py-4 sm:px-4 sm:py-6 lg:px-8">
			{hasSummary && (
				<section data-testid="public-summary" className="space-y-2">
					<h2 className="text-base font-semibold leading-6 tracking-tight text-gray-12">
						Summary
					</h2>
					<div className="prose prose-sm prose-gray max-w-none text-[15px] leading-6 text-gray-11 prose-p:my-2 prose-ul:my-2 prose-li:my-0 prose-strong:text-gray-12">
						<ReactMarkdown>{aiData.summary}</ReactMarkdown>
					</div>
				</section>
			)}

			{hasChapters && (
				<section
					data-testid="public-chapters"
					className={hasSummary ? "mt-6" : ""}
				>
					<h2 className="mb-2 text-base font-semibold leading-6 tracking-tight text-gray-12">
						Chapters
					</h2>
					<div className="space-y-1.5">
						{aiData.chapters?.map((chapter) => {
							const timestamp = formatTimeMinutes(chapter.start);
							return (
								<div
									key={chapter.start}
									className="grid w-full grid-cols-[3.5rem_minmax(0,1fr)] items-baseline gap-3 py-0.5 text-gray-12"
								>
									<button
										type="button"
										aria-label={`Seek to ${timestamp}`}
										className="justify-self-start font-mono text-sm text-blue-10 underline-offset-2 transition-colors hover:text-blue-11 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9 focus-visible:ring-offset-2"
										onClick={() => handleSeek(chapter.start)}
									>
										{timestamp}
									</button>
									<span
										data-testid="chapter-title"
										className="min-w-0 text-[15px] font-normal leading-6"
									>
										{chapter.title}
									</span>
								</div>
							);
						})}
					</div>
				</section>
			)}
		</div>
	);
};

export default SummaryChapters;

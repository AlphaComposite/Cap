export function isSummaryTabDisabled(
	isOwner: boolean,
	_summaryDisabled: boolean | null | undefined,
) {
	return !isOwner;
}

export function areAllSidebarTabsDisabled({
	isOwner,
	isScreenshot,
	commentsDisabled,
	transcriptDisabled,
}: {
	isOwner: boolean;
	isScreenshot: boolean;
	commentsDisabled: boolean;
	transcriptDisabled: boolean;
}) {
	if (isScreenshot) return commentsDisabled;
	return commentsDisabled && transcriptDisabled && !isOwner;
}

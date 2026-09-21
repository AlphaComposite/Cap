export function isSummaryTabDisabled(
	isOwner: boolean,
	summaryDisabled: boolean | null | undefined,
) {
	return !isOwner && Boolean(summaryDisabled);
}

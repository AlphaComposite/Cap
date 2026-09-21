export function isSummaryTabDisabled(
	isOwner: boolean,
	_summaryDisabled: boolean | null | undefined,
) {
	return !isOwner;
}

export function nextSettlePrepare(
	previous: AbortController | null,
	requestId: number,
): { requestId: number; controller: AbortController } {
	previous?.abort();
	return { requestId: requestId + 1, controller: new AbortController() };
}

export function beginDoneFence(
	requestId: number,
	controller: AbortController | null,
): { requestId: number; controller: null } {
	controller?.abort();
	return { requestId: requestId + 1, controller: null };
}

export function acceptSettledPrepare(
	responseRequestId: number,
	currentRequestId: number,
): boolean {
	return responseRequestId === currentRequestId;
}

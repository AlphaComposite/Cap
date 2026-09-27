export const SETTLE_PREPARE_DEBOUNCE_MS = 150;

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
	options?: { join?: boolean },
): { requestId: number; controller: AbortController | null; joined: boolean } {
	const join = options?.join === true && controller != null && !controller.signal.aborted;
	if (!join) controller?.abort();
	return {
		requestId: requestId + 1,
		controller: join ? controller : null,
		joined: join,
	};
}

export function acceptSettledPrepare(
	responseRequestId: number,
	currentRequestId: number,
): boolean {
	return responseRequestId === currentRequestId;
}

export function shouldJoinInflightPrepare(input: {
	inflightMatches: boolean;
	aborted: boolean;
	sent: boolean;
}): boolean {
	return input.inflightMatches && input.sent && !input.aborted;
}

export function shouldStartPrepareOnPointerDown(input: {
	sameSpec: boolean;
	ready: boolean;
	sent: boolean;
	aborted: boolean;
}): boolean {
	if (input.sameSpec && input.ready) return false;
	if (input.sameSpec && input.sent && !input.aborted) return false;
	return true;
}

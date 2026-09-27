export type PrepareOnce = {
	arm: (key: string, delayMs: number, send: () => void) => void;
	flush: (key: string, send: () => void) => void;
	cancelTimer: () => void;
	sentKey: () => string | null;
	forgetIfDifferent: (key: string) => void;
};

export function createPrepareOnce(): PrepareOnce {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let sentKey: string | null = null;
	const cancelTimer = () => {
		if (timer === null) return;
		clearTimeout(timer);
		timer = null;
	};
	const sendOnce = (key: string, send: () => void) => {
		if (sentKey === key) return;
		sentKey = key;
		send();
	};
	return {
		arm(key, delayMs, send) {
			if (sentKey === key) return;
			cancelTimer();
			timer = setTimeout(() => {
				timer = null;
				sendOnce(key, send);
			}, delayMs);
		},
		flush(key, send) {
			cancelTimer();
			sendOnce(key, send);
		},
		cancelTimer,
		sentKey: () => sentKey,
		forgetIfDifferent(key) {
			if (sentKey !== null && sentKey !== key) sentKey = null;
		},
	};
}

export function prepareSpecKey(spec: unknown): string {
	return JSON.stringify(spec);
}

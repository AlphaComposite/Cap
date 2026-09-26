const prefetched = new Map<string, ArrayBuffer>();
const inflight = new Map<string, Promise<ArrayBuffer>>();

type PendingLoad = {
	deliver: (bytes: ArrayBuffer) => void;
	timer: ReturnType<typeof setTimeout>;
};

const pendingLoads = new Map<string, PendingLoad[]>();

export function fragmentCacheKey(url: string): string {
	const parsed = new URL(url, "http://cap.local");
	return `${parsed.pathname}${parsed.search}`;
}

function takePending(key: string): PendingLoad[] {
	const waiters = pendingLoads.get(key) ?? [];
	pendingLoads.delete(key);
	return waiters;
}

export function rememberPrefetchedFragment(
	url: string,
	bytes: ArrayBuffer,
): void {
	if (bytes.byteLength === 0) return;
	const key = fragmentCacheKey(url);
	prefetched.set(key, bytes);
	for (const waiter of takePending(key)) {
		clearTimeout(waiter.timer);
		waiter.deliver(bytes);
	}
}

export function registerInflightFragment(
	url: string,
	pending: Promise<ArrayBuffer>,
): void {
	const key = fragmentCacheKey(url);
	const tracked = pending.then((bytes) => {
		if (bytes.byteLength > 0) rememberPrefetchedFragment(url, bytes);
		return bytes;
	});
	inflight.set(key, tracked);
	void tracked.catch(() => undefined);
	void tracked.finally(() => {
		if (inflight.get(key) === tracked) inflight.delete(key);
	});
}

export function readPrefetchedFragment(url: string): ArrayBuffer | null {
	return prefetched.get(fragmentCacheKey(url)) ?? null;
}

export function clearPrefetchedFragments(): void {
	prefetched.clear();
	inflight.clear();
	for (const waiters of pendingLoads.values()) {
		for (const waiter of waiters) clearTimeout(waiter.timer);
	}
	pendingLoads.clear();
}

function deliverFragment(
	onSuccess: (
		response: unknown,
		stats: unknown,
		context: unknown,
		network: null,
	) => void,
	url: string,
	bytes: ArrayBuffer,
	context: unknown,
) {
	const now = Date.now();
	onSuccess(
		{ url, data: bytes, code: 200 },
		{
			aborted: false,
			loaded: bytes.byteLength,
			retry: 0,
			total: bytes.byteLength,
			chunkCount: 1,
			bwEstimate: 0,
			loading: { start: now, first: now, end: now },
			parsing: { start: 0, end: 0 },
			buffering: { start: 0, first: 0, end: 0 },
		},
		context,
		null,
	);
}

function asSuccess(
	callbacks: { onSuccess?: unknown } | undefined,
):
	| ((
			response: unknown,
			stats: unknown,
			context: unknown,
			network: null,
	  ) => void)
	| null {
	return typeof callbacks?.onSuccess === "function"
		? (callbacks.onSuccess as (
				response: unknown,
				stats: unknown,
				context: unknown,
				network: null,
			) => void)
		: null;
}

export function createPrefetchLoader<
	T extends new (
		...args: never[]
	) => object,
>(Base: T): T {
	const Wrapped = class extends (Base as new (
		...args: never[]
	) => { load(...args: never[]): void }) {
		load(...args: never[]) {
			const context = args[0] as unknown as { url?: unknown };
			const callbacks = args[2] as unknown as { onSuccess?: unknown };
			const url = typeof context?.url === "string" ? context.url : "";
			const onSuccess = asSuccess(callbacks);
			const cached = readPrefetchedFragment(url);
			if (cached && onSuccess) {
				deliverFragment(onSuccess, url, cached, context);
				return;
			}
			const key = fragmentCacheKey(url);
			const flight = inflight.get(key);
			if (flight && onSuccess) {
				void flight.then(
					(bytes) => {
						if (bytes.byteLength === 0) {
							super.load(...args);
							return;
						}
						deliverFragment(onSuccess, url, bytes, context);
					},
					() => {
						super.load(...args);
					},
				);
				return;
			}
			if (!onSuccess) {
				super.load(...args);
				return;
			}
			let settled = false;
			const waiter: PendingLoad = {
				deliver(bytes) {
					if (settled) return;
					settled = true;
					deliverFragment(onSuccess, url, bytes, context);
				},
				timer: setTimeout(() => {
					if (settled) return;
					settled = true;
					const current = pendingLoads.get(key);
					if (current) {
						const next = current.filter((item) => item !== waiter);
						if (next.length === 0) pendingLoads.delete(key);
						else pendingLoads.set(key, next);
					}
					const lateCache = readPrefetchedFragment(url);
					if (lateCache) {
						deliverFragment(onSuccess, url, lateCache, context);
						return;
					}
					const lateFlight = inflight.get(key);
					if (lateFlight) {
						void lateFlight.then(
							(bytes) => {
								if (bytes.byteLength === 0) super.load(...args);
								else deliverFragment(onSuccess, url, bytes, context);
							},
							() => {
								super.load(...args);
							},
						);
						return;
					}
					super.load(...args);
				}, 0),
			};
			const existing = pendingLoads.get(key) ?? [];
			existing.push(waiter);
			pendingLoads.set(key, existing);
		}
	};
	return Wrapped as unknown as T;
}

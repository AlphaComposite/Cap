const prefetched = new Map<string, ArrayBuffer>();

export function fragmentCacheKey(url: string): string {
	const parsed = new URL(url, "http://cap.local");
	return `${parsed.pathname}${parsed.search}`;
}

export function rememberPrefetchedFragment(
	url: string,
	bytes: ArrayBuffer,
): void {
	if (bytes.byteLength === 0) return;
	prefetched.set(fragmentCacheKey(url), bytes);
}

export function readPrefetchedFragment(url: string): ArrayBuffer | null {
	return prefetched.get(fragmentCacheKey(url)) ?? null;
}

export function clearPrefetchedFragments(): void {
	prefetched.clear();
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
			const context = args[0] as { url?: unknown };
			const callbacks = args[2] as { onSuccess?: unknown };
			const url = typeof context?.url === "string" ? context.url : "";
			const cached = readPrefetchedFragment(url);
			const onSuccess =
				typeof callbacks?.onSuccess === "function" ? callbacks.onSuccess : null;
			if (!cached || !onSuccess) {
				super.load(...args);
				return;
			}
			const now = Date.now();
			onSuccess(
				{ url, data: cached, code: 200 },
				{
					aborted: false,
					loaded: cached.byteLength,
					retry: 0,
					total: cached.byteLength,
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
	};
	return Wrapped as unknown as T;
}

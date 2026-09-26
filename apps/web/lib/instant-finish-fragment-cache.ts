const MAX_STARTUP_FRAGMENTS = 3;
const prefetched = new Map<string, ArrayBuffer>();
let boundRevision: string | null = null;

export function fragmentCacheKey(url: string): string {
	const parsed = new URL(url, "http://cap.local");
	return `${parsed.pathname}${parsed.search}`;
}

function revisionOf(url: string): string | null {
	const match = /\/r\/([^/]+)\//.exec(fragmentCacheKey(url));
	return match?.[1] ?? null;
}

export function rememberPrefetchedFragment(
	url: string,
	bytes: ArrayBuffer,
): void {
	if (bytes.byteLength === 0) return;
	const revision = revisionOf(url);
	if (revision && boundRevision && revision !== boundRevision) {
		prefetched.clear();
	}
	if (revision) boundRevision = revision;
	const key = fragmentCacheKey(url);
	if (prefetched.has(key)) prefetched.delete(key);
	prefetched.set(key, bytes);
	while (prefetched.size > MAX_STARTUP_FRAGMENTS) {
		const oldest = prefetched.keys().next().value;
		if (!oldest) break;
		prefetched.delete(oldest);
	}
}

export function readPrefetchedFragment(url: string): ArrayBuffer | null {
	const key = fragmentCacheKey(url);
	const bytes = prefetched.get(key) ?? null;
	if (bytes) prefetched.delete(key);
	return bytes;
}

export function clearPrefetchedFragments(): void {
	prefetched.clear();
	boundRevision = null;
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

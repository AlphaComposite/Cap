import { SOURCE_RELOCATION_PENDING_MESSAGE } from "@/lib/revision-publish-client";

export type PublishRevisionResult =
	| { success: true; revisionId?: string; generation?: number }
	| { success: false; reason?: string; status?: number; message?: string };

export type DonePlan = "leave" | "legacy" | "published" | "conflict" | "error";

export type DoneRoute = "wait" | "save" | "publish";

export async function publishDoneWithRetry<T>(
	publish: (signal: AbortSignal) => Promise<T>,
	refresh: (error: unknown) => Promise<void>,
	onRelocationWait?: () => void,
	{
		signal = new AbortController().signal,
		beforeRetry,
	}: { signal?: AbortSignal; beforeRetry?: () => void } = {},
): Promise<T> {
	// The deadline limits new attempts, not an in-flight server publication.
	const deadline = performance.now() + 60_000;
	let refreshed = false;
	for (;;) {
		signal.throwIfAborted();
		try {
			const result = await publish(signal);
			signal.throwIfAborted();
			return result;
		} catch (error) {
			signal.throwIfAborted();
			if (
				typeof error !== "object" ||
				error === null ||
				!("status" in error) ||
				error.status !== 409 ||
				performance.now() >= deadline
			)
				throw error;
			if (
				"message" in error &&
				error.message === SOURCE_RELOCATION_PENDING_MESSAGE
			) {
				onRelocationWait?.();
				await new Promise<void>((resolve, reject) => {
					const abort = () => {
						clearTimeout(timer);
						reject(signal.reason);
					};
					const timer = setTimeout(
						() => {
							signal.removeEventListener("abort", abort);
							resolve();
						},
						Math.min(1_000, deadline - performance.now()),
					);
					signal.addEventListener("abort", abort, { once: true });
					if (signal.aborted) abort();
				});
			} else {
				if (refreshed) throw error;
				refreshed = true;
				await refresh(error);
			}
			signal.throwIfAborted();
			beforeRetry?.();
			if (performance.now() >= deadline) throw error;
		}
	}
}

export function doneRoute(
	state: { enabled: boolean } | null | undefined,
): DoneRoute {
	if (state == null) return "wait";
	return state.enabled ? "publish" : "save";
}

export type RestoreRoute = "wait" | "editor" | "legacy";

export function restoreRoute(
	state: { enabled: boolean } | null | undefined,
): RestoreRoute {
	if (state == null) return "wait";
	return state.enabled ? "editor" : "legacy";
}

export function planDoneAfterPublish(
	result: PublishRevisionResult,
): Exclude<DonePlan, "leave"> {
	if ("reason" in result && result.reason === "flag-off") return "legacy";
	if (result.success) return "published";
	if ("status" in result && result.status === 409) return "conflict";
	return "error";
}

export function readOrCreateDraftSession(
	storage: Pick<Storage, "getItem" | "setItem"> | null,
	videoId: string,
): string {
	const key = `cap:edit-draft-session:${videoId}`;
	const existing = storage?.getItem(key);
	if (existing && existing.length > 0 && existing.length <= 128)
		return existing;
	const created = `draft-${videoId}-${Math.random().toString(36).slice(2, 12)}`;
	storage?.setItem(key, created);
	return created;
}

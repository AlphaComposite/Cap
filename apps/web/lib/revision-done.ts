export type PublishRevisionResult =
	| { success: true; revisionId?: string; generation?: number }
	| { success: false; reason?: string; status?: number; message?: string };

export type DonePlan = "leave" | "legacy" | "published" | "conflict" | "error";

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

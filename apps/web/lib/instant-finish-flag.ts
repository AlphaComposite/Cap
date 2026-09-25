// CONTRACT STUB (owned by W-A)
// Integrator replaces this file. Keep INSTANT_FINISH_OWNER_IDS in sync with
// packages/web-backend/src/Videos/instantFinishFlag.ts until that replacement.

export function isInstantFinishEnabledForOwner(ownerId: string): boolean {
	const raw = process.env.INSTANT_FINISH_OWNER_IDS ?? "";
	if (raw.trim() === "") return false;
	return raw
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0)
		.includes(ownerId);
}

// CONTRACT STUB (owned by W-A)
// Integrator replaces this module. Flag means every viewer of this owner's
// videos, not the owner session alone.

const OWNER_ALLOWLIST_ENV = "CAP_INSTANT_FINISH_OWNER_IDS";

export function instantFinishOwnerAllowlist(): string[] {
	const raw = process.env[OWNER_ALLOWLIST_ENV] ?? "";
	return raw
		.split(",")
		.map((ownerId) => ownerId.trim())
		.filter((ownerId) => ownerId.length > 0);
}

export function isInstantFinishEnabledForOwner(ownerId: string): boolean {
	if (!ownerId) return false;
	return instantFinishOwnerAllowlist().includes(ownerId);
}

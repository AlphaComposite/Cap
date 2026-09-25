const OWNER_ENV = "CAP_INSTANT_FINISH_OWNERS";

export function instantFinishOwnerAllowlist(): string[] {
	const raw = process.env[OWNER_ENV] ?? "";
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export function isInstantFinishEnabledForOwner(ownerId: string): boolean {
	return instantFinishOwnerAllowlist().includes(ownerId);
}

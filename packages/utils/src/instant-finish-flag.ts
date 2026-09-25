export const INSTANT_FINISH_OWNER_ENV = "CAP_INSTANT_FINISH_OWNERS";

export function instantFinishOwnerAllowlist(
	env: Record<string, string | undefined> = process.env,
): string[] {
	const raw = env[INSTANT_FINISH_OWNER_ENV] ?? "";
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export function isInstantFinishEnabledForOwner(
	ownerId: string,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return instantFinishOwnerAllowlist(env).includes(ownerId);
}

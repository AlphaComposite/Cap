export function isInstantFinishEnabledForOwner(ownerId: string): boolean {
	const raw = process.env.INSTANT_FINISH_OWNER_IDS ?? "";
	if (raw.trim() === "") return false;
	return raw
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0)
		.includes(ownerId);
}

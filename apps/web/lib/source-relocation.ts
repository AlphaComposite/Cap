// CONTRACT STUB (owned by W-D)
// Integrator replaces this file with W-D's relocation writer.
// A reads source_object.liveKey via resolveRollbackSourceKey.
// D owns copy/verify/delete and the relocation journal.

export type RelocationState =
	| "INTENT"
	| "COPIED"
	| "POINTER"
	| "DELETED"
	| "PURGED"
	| "ABORTED";

export function resolveLegacySourceKey(input: {
	sourceKey: string;
	liveKey: string | null;
	relocations: Array<{
		oldKey: string;
		newKey: string;
		state: RelocationState;
	}>;
}) {
	const moved = input.relocations.find(
		(row) =>
			row.oldKey === input.sourceKey &&
			row.state !== "ABORTED" &&
			row.state !== "INTENT",
	);
	if (input.liveKey && moved) return input.liveKey;
	if (moved) return moved.newKey;
	return input.sourceKey;
}

export async function relocateKey(): Promise<never> {
	throw new Error("source relocation writer is owned by W-D");
}

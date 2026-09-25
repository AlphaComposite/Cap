import { sql } from "drizzle-orm";
import { isInstantFinishEnabledForOwner } from "./instantFinishFlag.ts";

type Executor = {
	execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

const missingTable = (error: unknown): boolean => {
	const record =
		typeof error === "object" && error !== null
			? (error as { errno?: number; code?: string; cause?: unknown })
			: null;
	if (record?.errno === 1146 || record?.code === "ER_NO_SUCH_TABLE")
		return true;
	return record?.cause !== undefined && record.cause !== error
		? missingTable(record.cause)
		: false;
};

export async function bumpPolicyEpochIfFlagged(
	executor: Executor,
	videoId: string,
	ownerId: string,
): Promise<void> {
	if (!isInstantFinishEnabledForOwner(ownerId)) return;
	try {
		await executor.execute(sql`
			UPDATE video_publication
			SET policyEpoch = policyEpoch + 1
			WHERE videoId = ${videoId}
		`);
	} catch (error) {
		if (missingTable(error)) {
			throw new Error("policy epoch bump failed closed");
		}
		throw error;
	}
}

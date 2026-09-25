export type ServingPublication = {
	currentRevisionId: string | null;
	currentGeneration: number | null;
	allocatedGeneration: number;
	publicationEpoch: number;
	policyEpoch: number;
};

export function classifyServingPublication(input: {
	revisionId: string;
	revisionGeneration: number;
	currentRevisionId: string | null;
	currentGeneration: number | null;
	allocatedGeneration: number;
}): { ok: true } | { ok: false; status: 410; reason: "non_current" } {
	if (
		input.currentRevisionId === input.revisionId &&
		input.currentGeneration != null &&
		input.currentGeneration === input.revisionGeneration
	) {
		return { ok: true };
	}
	return { ok: false, status: 410, reason: "non_current" };
}

export function allocateNextGeneration(
	publication: ServingPublication,
): ServingPublication {
	return {
		...publication,
		allocatedGeneration: publication.allocatedGeneration + 1,
	};
}

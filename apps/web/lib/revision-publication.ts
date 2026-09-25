// CONTRACT STUB (owned by W-A)
// Read-only publication projection the origin consumes. A owns the tables and writers.

export type PublicationProjection = {
	videoId: string;
	currentRevisionId: string | null;
	generation: number;
	publicationEpoch: number;
	policyEpoch: number;
};

export type RevisionProjection = {
	revisionId: string;
	videoId: string;
	intentId: string;
	sourceId: string;
	generation: number;
	state: "ALLOCATED" | "READY" | "CURRENT" | "FAILED" | "SUPERSEDED";
};

export type SourceObjectProjection = {
	videoId: string;
	liveKey: string;
	sha256: string;
	relocationState: string;
};

export type RevisionPrepareResult = {
	ready: true;
	intentId: string;
	durationSeconds: number;
	durationTicks: number;
	segmentCount: number;
	seg0DecodedFrames: number;
	encoderHash: string;
	segmentPlanVersion: 2;
};

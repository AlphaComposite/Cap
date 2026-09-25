// CONTRACT STUB (owned by W-A)
// Integrator replaces this module with the MySQL publication read.
// Summary is intentionally absent: the user-pasted summary persists on the
// video row and is not a revision artifact.

export type RevisionChapterDto = {
	title: string;
	start: number;
};

export type RevisionMetadataDto = {
	duration: number | null;
	chapters: RevisionChapterDto[] | null;
	captionsAvailable: boolean;
	commentTimestamps: Record<string, number | null> | null;
	thumbnailAvailable: boolean;
	downloadReady: boolean;
};

export type RevisionPublicationDto = {
	enabled: boolean;
	currentRevisionId: string | null;
	generation: number;
	duration: number | null;
	revisionMetadata: RevisionMetadataDto | null;
	draftVersion: number;
	draftSession: string | null;
};

export function disabledRevisionPublication(): RevisionPublicationDto {
	return {
		enabled: false,
		currentRevisionId: null,
		generation: 0,
		duration: null,
		revisionMetadata: null,
		draftVersion: 0,
		draftSession: null,
	};
}

export async function getRevisionPublication(input: {
	videoId: string;
	ownerId: string;
}): Promise<RevisionPublicationDto> {
	const { isInstantFinishEnabledForOwner } = await import(
		"./instant-finish-flag"
	);
	return {
		...disabledRevisionPublication(),
		enabled: isInstantFinishEnabledForOwner(input.ownerId),
	};
}

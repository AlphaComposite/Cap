export const DOWNLOAD_PREPARING_MESSAGE =
	"Preparing your download. Try again in a minute.";

export type EditedDownloadUrlLookup = (input: {
	videoId: string;
	ownerId: string;
}) => Promise<string | null>;

export type RevisionDownloadOutcome =
	| { status: "legacy" }
	| { status: "ready"; fileName: string; downloadUrl: string }
	| {
			status: "preparing";
			message: typeof DOWNLOAD_PREPARING_MESSAGE;
	  };

let editedDownloadUrlLookup: EditedDownloadUrlLookup | null = null;

export function registerEditedDownloadUrlLookup(next: EditedDownloadUrlLookup) {
	editedDownloadUrlLookup = next;
}

export function currentEditedDownloadUrlLookup() {
	return editedDownloadUrlLookup;
}

export function revisionDownloadOutcome(input: {
	flagged: boolean;
	eligible: boolean;
	name: string;
	downloadUrl: string | null;
}): RevisionDownloadOutcome {
	if (!input.flagged || input.eligible) return { status: "legacy" };
	if (!input.downloadUrl) {
		return {
			status: "preparing",
			message: DOWNLOAD_PREPARING_MESSAGE,
		};
	}
	return {
		status: "ready",
		fileName: `${input.name}.mp4`,
		downloadUrl: input.downloadUrl,
	};
}

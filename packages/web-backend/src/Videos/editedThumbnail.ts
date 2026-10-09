export type EditedThumbnailUrlLookup = (input: {
	videoId: string;
	ownerId: string;
}) => Promise<string | null>;

let editedThumbnailUrlLookup: EditedThumbnailUrlLookup | null = null;

export function registerEditedThumbnailUrlLookup(
	next: EditedThumbnailUrlLookup,
) {
	editedThumbnailUrlLookup = next;
}

export function currentEditedThumbnailUrlLookup() {
	return editedThumbnailUrlLookup;
}

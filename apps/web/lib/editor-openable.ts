export type EditorSource = {
	liveKey: string;
	sha256: string;
	relocationState?: string;
	codec: string | null;
	timebase: string | null;
	frameMode: string | null;
	a1Digest: string | null;
	indexId: string | null;
	warmExpiresAt: Date | null;
};

export type EditorRelocation = {
	oldKey: string;
	newKey: string;
	sha256: string;
	state: string;
};

export function editorOpenable(input: {
	videoId: string;
	source: EditorSource | null;
	relocations: EditorRelocation[];
	pending: boolean;
	now: Date;
}): boolean {
	const { source, videoId } = input;
	if (
		!source ||
		!/^[a-f0-9]{64}$/.test(source.sha256) ||
		!source.codec ||
		!source.timebase ||
		(source.frameMode !== "cfr" && source.frameMode !== "vfr") ||
		!source.a1Digest ||
		!source.indexId
	)
		return false;
	if (
		source.relocationState === "PURGED" &&
		source.liveKey.startsWith(`private/source/${videoId}/`) &&
		!["*", "?", ".."].some((token) => source.liveKey.includes(token))
	)
		return true;
	return (
		input.pending &&
		source.warmExpiresAt !== null &&
		new Date(source.warmExpiresAt).getTime() > input.now.getTime() &&
		input.relocations.some(
			(row) =>
				row.sha256 === source.sha256 &&
				(row.oldKey === source.liveKey || row.newKey === source.liveKey) &&
				row.newKey.startsWith(`private/source/${videoId}/`) &&
				!["*", "?", ".."].some((token) => row.newKey.includes(token)) &&
				!row.newKey.startsWith("/") &&
				["COPIED", "POINTER", "PURGED"].includes(row.state),
		)
	);
}

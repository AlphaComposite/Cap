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
	return (
		source.relocationState === "PURGED" &&
		input.relocations.every((row) => row.state === "PURGED") &&
		source.liveKey.startsWith(`private/source/${videoId}/`) &&
		!["*", "?", ".."].some((token) => source.liveKey.includes(token))
	);
}

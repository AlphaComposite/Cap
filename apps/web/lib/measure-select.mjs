export function selectPublish(rows) {
	return (
		rows.find((row) => row.method === "POST" && row.hasPlaylistUrl === true) ??
		null
	);
}

export function legacyLargeAction(rows) {
	const actions = rows.filter((row) => row.kind === "action");
	const large = actions.filter((row) => (row.bytes ?? 0) > 1024);
	return large.at(-1) ?? actions.at(-1) ?? null;
}

export function selectSeg0End(input) {
	const prefetchEndedBeforePlaylist =
		input.networkSeg0End != null &&
		input.playlistStart != null &&
		input.networkSeg0End < input.playlistStart;
	const append = (input.appends ?? []).find(
		(row) => row.share === true && row.byteLength === input.seg0ByteLength,
	);
	if (!append) return null;
	if (
		prefetchEndedBeforePlaylist &&
		input.networkSeg0End != null &&
		append.wall === input.networkSeg0End
	) {
		return null;
	}
	return append.wall;
}

export function countSeg0Gets(rows, revisionId) {
	return rows.filter(
		(row) =>
			row.method === "GET" &&
			row.kind === "seg0" &&
			String(row.path).includes(`/r/${revisionId}/`),
	).length;
}

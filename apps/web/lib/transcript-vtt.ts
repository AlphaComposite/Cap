export function validateTranscriptSpeaker(value: unknown): string | null {
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value)
		? value
		: null;
}

export function escapeTranscriptCueText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function decodeTranscriptCueText(text: string): string {
	const entities: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		nbsp: "\u00a0",
		lrm: "\u200e",
		rlm: "\u200f",
	};
	return text.replace(
		/&(amp|lt|gt|nbsp|lrm|rlm);/g,
		(entity, name: string) => entities[name] ?? entity,
	);
}

export function parseTranscriptCuePayload(
	value: string,
): { text: string; speaker: string | null } | null {
	const voice = value.match(
		/^<v cap-speaker-([A-Za-z0-9_-]{1,32})>([^<>]*)<\/v>$/,
	);
	const plain = value.match(/^<c\.cap-text>([^<>]*)<\/c>$/);
	const payload = voice?.[2] ?? plain?.[1];
	if (payload === undefined) return null;
	return {
		text: decodeTranscriptCueText(payload),
		speaker: voice?.[1] ?? null,
	};
}

export function projectTranscriptCueText(value: string): string {
	return parseTranscriptCuePayload(value)?.text ?? value;
}

export function formatTranscriptCuePayload(
	text: string,
	speaker?: unknown,
): string {
	const id = validateTranscriptSpeaker(speaker);
	if (id)
		return `<v cap-speaker-${id}>${escapeTranscriptCueText(normalizeTranscriptCueText(text))}</v>`;
	return /[<>]/.test(text)
		? `<c.cap-text>${escapeTranscriptCueText(normalizeTranscriptCueText(text))}</c>`
		: text;
}

export function stripTranscriptVoiceAnnotations(vtt: string): string {
	return vtt
		.replace(/<v(?:[ .][^>\n]*)?>/g, "<c.cap-text>")
		.replace(/<\/v>/g, "</c>");
}

export function normalizeTranscriptCueText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function updateVttEntryText(
	vttContent: string,
	entryId: number,
	newText: string,
): { content: string; updated: boolean } {
	const normalizedText = normalizeTranscriptCueText(newText);
	const lines = vttContent.split(/\r?\n/);
	const updatedLines: string[] = [];
	let index = 0;
	let updated = false;

	while (index < lines.length) {
		const line = lines[index] ?? "";
		const trimmedLine = line.trim();

		if (!/^\d+$/.test(trimmedLine)) {
			updatedLines.push(line);
			index++;
			continue;
		}

		const cueId = parseInt(trimmedLine, 10);
		const cueStart = index;
		let cueEnd = cueStart + 1;

		while (cueEnd < lines.length && (lines[cueEnd] ?? "").trim() !== "") {
			cueEnd++;
		}

		if (cueId !== entryId) {
			updatedLines.push(...lines.slice(cueStart, cueEnd));
			if (cueEnd < lines.length) {
				updatedLines.push(lines[cueEnd] ?? "");
			}
			index = cueEnd + 1;
			continue;
		}

		const cueLines = lines.slice(cueStart, cueEnd);
		const timingIndex = cueLines.findIndex((cueLine) =>
			cueLine.includes("-->"),
		);

		if (timingIndex === -1) {
			updatedLines.push(...cueLines);
			if (cueEnd < lines.length) {
				updatedLines.push(lines[cueEnd] ?? "");
			}
			index = cueEnd + 1;
			continue;
		}

		const originalPayload = cueLines.slice(timingIndex + 1).join("\n");
		const original = parseTranscriptCuePayload(originalPayload);
		const payload = original
			? original.speaker
				? formatTranscriptCuePayload(normalizedText, original.speaker)
				: `<c.cap-text>${escapeTranscriptCueText(normalizedText)}</c>`
			: formatTranscriptCuePayload(normalizedText);
		updatedLines.push(...cueLines.slice(0, timingIndex + 1), payload);
		if (cueEnd < lines.length) {
			updatedLines.push(lines[cueEnd] ?? "");
		}
		updated = true;
		index = cueEnd + 1;
	}

	return {
		content: updatedLines.join("\n"),
		updated,
	};
}

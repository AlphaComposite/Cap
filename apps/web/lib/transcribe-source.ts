import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import {
	type RelocationState,
	resolveLegacySourceKey,
} from "@/lib/source-relocation";

export function transcribeTempAudioKey(
	userId: string,
	videoId: string,
	filename: string,
	env: Record<string, string | undefined> = process.env,
): string {
	// Inventory may finish between audio extraction and the transcription step.
	return isInstantFinishEnabledForOwner(userId, env)
		? `private/source/${videoId}/${filename}`
		: `${userId}/${videoId}/${filename}`;
}

export function transcribeSourceCandidateKeys(input: {
	userId: string;
	videoId: string;
	sourceKeyOverride?: string | null;
	rawFileKey?: string | null;
	liveKey?: string | null;
	relocations: Array<{
		oldKey: string;
		newKey: string;
		state: RelocationState;
	}>;
}): string[] {
	const resultKey = `${input.userId}/${input.videoId}/result.mp4`;
	const publicKeys = [
		input.sourceKeyOverride,
		resultKey,
		input.rawFileKey,
	].filter(
		(value, index, values): value is string =>
			Boolean(value) && values.indexOf(value) === index,
	);
	const mapped: string[] = [];
	if (input.sourceKeyOverride) {
		mapped.push(
			resolveLegacySourceKey({
				sourceKey: input.sourceKeyOverride,
				liveKey: input.liveKey ?? null,
				relocations: input.relocations,
			}),
		);
	}
	if (input.rawFileKey) {
		mapped.push(
			resolveLegacySourceKey({
				sourceKey: input.rawFileKey,
				liveKey: input.liveKey ?? null,
				relocations: input.relocations,
			}),
		);
	}
	if (input.liveKey?.startsWith("private/source/")) mapped.push(input.liveKey);
	const keys = [...publicKeys];
	for (const key of mapped) {
		if (key && !keys.includes(key)) keys.push(key);
	}
	return keys;
}

export function chooseTranscribeSourceKey(
	input: Parameters<typeof transcribeSourceCandidateKeys>[0] & {
		present: (key: string) => boolean;
	},
): string | null {
	return (
		transcribeSourceCandidateKeys(input).find((key) => input.present(key)) ??
		null
	);
}

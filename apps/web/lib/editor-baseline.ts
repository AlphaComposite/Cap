import type { VideoEditSpec } from "@cap/database/types";
import { createIdentityEditSpec } from "@/lib/video-edits";

/**
 * Editor baseline (the "expectedEditSpec" sent at Done). Must use the same
 * precedence as the server's previousEditionSpec: current published intent,
 * then the legacy video_edits row, then identity. Otherwise, after the first
 * instant-finish publish, every later Done is refused 409 (cap-fzp.8.7.31).
 */
export function selectEditorBaselineSpec(input: {
	instantFinish: boolean;
	publishedIntentSpec: VideoEditSpec | null;
	legacySpec: VideoEditSpec | null;
	sourceDuration: number;
}): VideoEditSpec {
	if (input.instantFinish && input.publishedIntentSpec) {
		return input.publishedIntentSpec;
	}
	if (input.legacySpec) return input.legacySpec;
	return createIdentityEditSpec(input.sourceDuration);
}

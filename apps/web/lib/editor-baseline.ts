import type { VideoEditSpec } from "@cap/database/types";
import {
	areEditSpecDocumentsEquivalent,
	areEditSpecsEquivalent,
	createIdentityEditSpec,
	createTimelineStateFromEditSpec,
	getTimelineEditSpec,
} from "@/lib/video-edits";

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
		if (
			input.publishedIntentSpec.version === 2 &&
			input.legacySpec?.version === 2 &&
			input.legacySpec.autoCutsInitialized === true
		) {
			const resetMedia = { ...input.legacySpec };
			delete resetMedia.autoCutsInitialized;
			if (areEditSpecDocumentsEquivalent(input.publishedIntentSpec, resetMedia))
				return { ...input.publishedIntentSpec, autoCutsInitialized: true };
		}
		return input.publishedIntentSpec;
	}
	if (input.legacySpec) return input.legacySpec;
	return createIdentityEditSpec(input.sourceDuration);
}

/**
 * Whether Restore should offer to discard a saved edit. Instant-finish edits
 * may exist without a legacy video_edits row (cap-fzp.8.7.34).
 */
export function editorHasExistingEdits(input: {
	instantFinish: boolean;
	hasLegacyRow: boolean;
	baseline: VideoEditSpec;
}): boolean {
	if (!input.instantFinish && !input.hasLegacyRow) return false;
	return !areEditSpecsEquivalent(
		input.baseline,
		createIdentityEditSpec(input.baseline.sourceDuration),
	);
}

/**
 * Spec for Restore under instant finish: the uncut original with pause/filler
 * auto-cuts off. Marked initialized so the transcript sidebar does not
 * re-apply default auto-cuts on top of the restore (cap-fzp.8.7.34).
 */
export function restoredEditorSpec(sourceDuration: number): VideoEditSpec {
	const identity = getTimelineEditSpec(
		createTimelineStateFromEditSpec(createIdentityEditSpec(sourceDuration)),
	);
	return { ...identity, autoCutsInitialized: true };
}

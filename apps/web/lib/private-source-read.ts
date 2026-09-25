// CONTRACT STUB (owned by W-D)
// Integrator replaces this file. A does not mint a presign here.
// D's live names: resolveLiveOriginal, mapLegacySourceKey, ownerOriginalObjectKey.
// A reads source_object.liveKey through resolveRollbackSourceKey.

export async function resolveLiveOriginal(
	_videoId: string,
): Promise<{ liveKey: string; sha256: string } | null> {
	return null;
}

export async function mapLegacySourceKey(_videoId: string, sourceKey: string) {
	return sourceKey;
}

export async function ownerOriginalObjectKey(videoId: string, ownerId: string) {
	return `${ownerId}/${videoId}/source/original.mp4`;
}

// CONTRACT STUB (owned by W-D)
// Integrator replaces this file with W-D's grant module.
// ownerOriginalPath is the editor-open URL. It must not be an S3 presign.

export function ownerOriginalPath(videoId: string) {
	return `/api/media/original?videoId=${encodeURIComponent(videoId)}`;
}

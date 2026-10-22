"use client";

import type { Video } from "@cap/web-domain";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
	getVideoDownloadInfo,
	type VideoDownloadVariant,
} from "@/actions/videos/download";
import { saveUrlDirectly, saveViaBlob } from "@/lib/dashboard-download";

/**
 * Fetches a signed URL and saves it to disk, with a toast for the wait.
 *
 * Shared because downloads are offered from three places now: the editor's
 * own menu, the share page's "Manage Cap" menu, and the plain Download button
 * a space member sees on someone else's Cap.
 */
export function useVideoDownload(videoId: Video.VideoId) {
	const [isDownloading, setIsDownloading] = useState(false);

	const download = useCallback(
		(variant: VideoDownloadVariant) => {
			if (isDownloading) return;
			setIsDownloading(true);

			const run = async () => {
				const result = await getVideoDownloadInfo(videoId, variant);
				if (!result.success) {
					if ("pending" in result) {
						toast.message(result.message);
						return;
					}
					throw new Error(result.error);
				}

				const { downloadUrl, filename } = result;
				if (saveUrlDirectly(downloadUrl, filename)) {
					toast.success("Download started");
					return;
				}
				const saving = saveViaBlob(downloadUrl, filename);
				toast.promise(saving, {
					loading: "Preparing download...",
					success: "Download started",
					error: (error) =>
						error instanceof Error ? error.message : "Failed to download video",
				});
				await saving.catch(() => undefined);
			};

			void run()
				.catch((error) => {
					toast.error(
						error instanceof Error ? error.message : "Failed to download video",
					);
				})
				.finally(() => setIsDownloading(false));
		},
		[videoId, isDownloading],
	);

	return { download, isDownloading };
}

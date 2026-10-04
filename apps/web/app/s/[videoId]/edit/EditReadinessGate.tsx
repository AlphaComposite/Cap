"use client";

import type { Video } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useEditReadiness } from "../../../../hooks/use-edit-readiness";

export function EditReadinessStatus({
	state,
}: {
	state: ReturnType<typeof useEditReadiness>;
}) {
	return (
		<div
			className="flex flex-wrap items-center gap-2 text-xs text-gray-11"
			aria-live="polite"
		>
			<span>
				{state.readiness
					? `${state.readiness.videoLabel} · ${state.readiness.transcriptLabel}`
					: state.message}
			</span>
			{state.readiness && state.message && <span>{state.message}</span>}
			<button
				type="button"
				disabled={state.checking}
				className="underline disabled:opacity-50"
				onClick={(event) => {
					event.stopPropagation();
					state.checkAgain();
				}}
			>
				Check again
			</button>
		</div>
	);
}

export function EditReadinessGate({ videoId }: { videoId: Video.VideoId }) {
	const state = useEditReadiness(videoId);
	const router = useRouter();
	return (
		<main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
			<h1 className="text-xl font-medium">Preparing your video editor</h1>
			<EditReadinessStatus state={state} />
			<p className="text-sm text-gray-11">
				Video preparation is separate from transcription. Once the video is
				processed, manual timeline editing does not require a transcript.
			</p>
			<p className="text-sm text-gray-11">
				If preparation failed, use the existing recovery controls on the share
				page.
			</p>
			{state.readiness?.manualEditing && (
				<button
					type="button"
					className="self-start rounded-lg bg-gray-12 px-4 py-2 text-gray-1"
					onClick={() => router.refresh()}
				>
					Open timeline editor
				</button>
			)}
			<a className="text-sm underline" href={`/s/${videoId}`}>
				Back to share page
			</a>
		</main>
	);
}

"use client";

import type { Video } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
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
	const refreshed = useRef<string | null>(null);
	// router.refresh() is void, and a remount clears refs. Record the identity before refresh so a still-preparing server cannot loop.
	useEffect(() => {
		if (refreshed.current && !refreshed.current.startsWith(`${videoId}\0`)) {
			refreshed.current = null;
		}
		const readiness = state.readiness;
		if (!readiness || readiness.videoId !== videoId) return;
		if (readiness.editorOpenable !== true) return;
		const token = `${videoId}\0${readiness.identity}`;
		if (refreshed.current === token) return;
		const storageKey = `cap.edit-readiness.reentry.${videoId}`;
		try {
			if (
				typeof sessionStorage !== "undefined" &&
				sessionStorage.getItem(storageKey) === readiness.identity
			) {
				refreshed.current = token;
				return;
			}
		} catch {
			return;
		}
		try {
			if (typeof sessionStorage !== "undefined") {
				sessionStorage.setItem(storageKey, readiness.identity);
			}
		} catch {
			return;
		}
		refreshed.current = token;
		router.refresh();
	}, [state.readiness, videoId, router]);
	return (
		<main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
			<h1 className="text-xl font-medium">Preparing for editing…</h1>
			<output className="text-sm text-gray-11">
				{state.readiness?.processingSummary || state.message}
			</output>
			<EditReadinessStatus state={state} />
			<p className="text-sm text-gray-11">
				This usually takes about 1–2 min. The editor will open automatically
				when preparation finishes. You can keep using the share page meanwhile.
			</p>
			<p className="text-sm text-gray-11">
				If preparation failed, use the existing recovery controls on the share
				page.
			</p>
			{state.readiness?.editorOpenable && (
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

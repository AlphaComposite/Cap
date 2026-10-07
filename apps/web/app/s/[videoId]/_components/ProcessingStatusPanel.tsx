"use client";

import type { Video } from "@cap/web-domain";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, CircleAlert, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { retryVideoProcessing } from "@/actions/video/retry-processing";
import type { EditReadiness } from "@/lib/video-edit-readiness";
import type { useEditReadiness } from "../../../../hooks/use-edit-readiness";

type ProcessingStep = EditReadiness["rows"][number];

const stateIcons = {
	waiting: Circle,
	running: LoaderCircle,
	done: CheckCircle2,
	failed: CircleAlert,
};

export function ProcessingStatusPanel({
	videoId,
	state,
}: {
	videoId: Video.VideoId;
	state: Pick<
		ReturnType<typeof useEditReadiness>,
		"readiness" | "checking" | "message" | "checkAgain"
	>;
}) {
	const queryClient = useQueryClient();
	const router = useRouter();
	const [retrying, setRetrying] = useState<ProcessingStep["id"] | null>(null);
	const [retryError, setRetryError] = useState<{
		id: ProcessingStep["id"];
		message: string;
	} | null>(null);
	const observed = useRef({
		videoId,
		openable: null as boolean | null,
		toasted: false,
	});
	const readiness = state.readiness;
	const editorOpenable = readiness?.editorOpenable;

	useEffect(() => {
		if (observed.current.videoId !== videoId) {
			observed.current = { videoId, openable: null, toasted: false };
		}
		if (editorOpenable === undefined) return;
		if (
			observed.current.openable === false &&
			editorOpenable &&
			!observed.current.toasted
		) {
			observed.current.toasted = true;
			toast.success("Ready to edit");
		}
		observed.current.openable = editorOpenable;
	}, [videoId, editorOpenable]);

	const retry = async (row: ProcessingStep) => {
		if (!row.retry || row.id === "sourcePrepare" || retrying) return;
		setRetrying(row.id);
		setRetryError(null);
		try {
			if (row.retry === "processing") {
				await retryVideoProcessing({ videoId });
				await queryClient.invalidateQueries({
					queryKey: ["getUploadProgress", videoId],
				});
			} else {
				const endpoint =
					row.retry === "transcript" ? "retry-transcription" : "retry-ai";
				const response = await fetch(`/api/videos/${videoId}/${endpoint}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
				});
				if (!response.ok) throw new Error("Could not retry. Please try again.");
				if (row.retry === "transcript") {
					await queryClient.invalidateQueries({
						queryKey: ["transcript", videoId],
					});
				}
			}
			await queryClient.invalidateQueries({
				queryKey: ["videoStatus", videoId],
			});
			state.checkAgain();
			router.refresh();
		} catch (error) {
			setRetryError({
				id: row.id,
				message:
					error instanceof Error
						? error.message
						: "Could not retry. Please try again.",
			});
		} finally {
			setRetrying(null);
		}
	};

	return (
		<output
			aria-live="off"
			aria-label="Video processing"
			className="block rounded-xl border border-gray-5 bg-gray-2 px-4 py-3 text-sm text-gray-12"
		>
			<h2 className="font-medium">
				{editorOpenable
					? "Ready to edit"
					: readiness &&
							!readiness.poll &&
							readiness.rows.some((row) => row.state === "failed")
						? "Processing failed"
						: "Processing…"}
			</h2>
			<p
				aria-live="polite"
				aria-atomic="true"
				className={readiness?.allDone ? "sr-only" : "mt-1 text-gray-11"}
			>
				{readiness?.processingSummary || state.message}
			</p>
			{readiness && !readiness.allDone && (
				<ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{readiness.rows.map((row) => {
						const Icon = stateIcons[row.state];
						return (
							<li
								key={row.id}
								role={row.state === "failed" ? "alert" : undefined}
								className="flex items-start gap-2"
							>
								<Icon
									aria-hidden="true"
									className={`mt-0.5 size-4 shrink-0 ${
										row.state === "running"
											? "motion-safe:animate-spin text-blue-500"
											: row.state === "failed"
												? "text-red-500"
												: row.state === "done"
													? "text-green-600"
													: "text-gray-9"
									}`}
								/>
								<div className="min-w-0">
									<p>{row.label}</p>
									<p className="text-xs text-gray-10 capitalize">{row.state}</p>
									{row.id === "sourcePrepare" && row.state === "running" && (
										<p className="text-xs text-gray-10">
											Usually takes about 1–2 min.
										</p>
									)}
									{row.reason && (
										<p className="text-xs text-gray-11">{row.reason}</p>
									)}
									{row.state === "failed" &&
										row.retry &&
										row.id !== "sourcePrepare" && (
											<button
												type="button"
												aria-label={`Retry ${row.label}`}
												disabled={retrying !== null}
												onClick={() => void retry(row)}
												className="mt-1 rounded-md border border-gray-5 px-2 py-1 text-xs hover:bg-gray-4 disabled:opacity-50"
											>
												{retrying === row.id ? "Retrying…" : "Retry"}
											</button>
										)}
									{retryError?.id === row.id && (
										<p className="mt-1 text-xs text-red-500">
											{retryError.message}
										</p>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</output>
	);
}

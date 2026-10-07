"use client";

import type { Video } from "@cap/web-domain";
import { useEffect, useRef, useState } from "react";
import { getEditReadiness } from "../actions/videos/get-edit-readiness";
import type { EditReadiness } from "../lib/video-edit-readiness";

export function useEditReadiness(
	videoId: Video.VideoId,
	enabled = true,
	context = "",
	includeTranscript = true,
) {
	const [check, setCheck] = useState(0);
	const key = JSON.stringify([
		videoId,
		enabled,
		context,
		check,
		includeTranscript,
	]);
	const [state, setState] = useState<{
		key: string;
		readiness: EditReadiness | null;
		checking: boolean;
		message: string;
	}>({
		key,
		readiness: null,
		checking: enabled,
		message: "Checking readiness",
	});
	const flight = useRef<Promise<unknown> | null>(null);
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let failures = 0;
		const started = Date.now();
		const schedule = () => {
			timer = setTimeout(
				() => void read(),
				failures
					? Math.min(5000 * 2 ** Math.min(failures - 1, 3), 30_000)
					: Date.now() - started < 5 * 60 * 1000
						? 2000
						: 5000,
			);
		};
		setState({
			key,
			readiness: null,
			checking: enabled,
			message: enabled ? "Checking readiness" : "",
		});
		async function read() {
			if (flight.current) await flight.current.catch(() => undefined);
			if (cancelled) return;
			setState((previous) => ({ ...previous, checking: true }));
			const request = getEditReadiness(videoId, includeTranscript);
			flight.current = request;
			try {
				const result = await request;
				if (cancelled) return;
				if (result.status !== "ready" || result.readiness.videoId !== videoId) {
					throw new Error("Unable to check readiness");
				}
				failures = result.readiness.rows.some(
					(row) => row.state === "unavailable",
				)
					? failures + 1
					: 0;
				setState({
					key,
					readiness: result.readiness,
					checking: false,
					message: "",
				});
				if (result.readiness.poll) schedule();
			} catch {
				if (!cancelled) {
					failures += 1;
					setState({
						key,
						readiness: null,
						checking: false,
						message: "Unable to check readiness",
					});
					schedule();
				}
			} finally {
				if (flight.current === request) flight.current = null;
			}
		}
		if (enabled) void read();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [key, videoId, enabled, includeTranscript]);
	const current =
		state.key === key
			? state
			: {
					readiness: null,
					checking: enabled,
					message: enabled ? "Checking readiness" : "",
				};
	return { ...current, checkAgain: () => setCheck((value) => value + 1) };
}

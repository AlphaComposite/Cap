"use client";

import type { Video } from "@cap/web-domain";
import { useEffect, useRef, useState } from "react";
import { getEditReadiness } from "../actions/videos/get-edit-readiness";
import type { EditReadiness } from "../lib/video-edit-readiness";

export function useEditReadiness(
	videoId: Video.VideoId,
	enabled = true,
	context = "",
) {
	const [check, setCheck] = useState(0);
	const key = JSON.stringify([videoId, enabled, context, check]);
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
		let attempts = 0;
		setState({
			key,
			readiness: null,
			checking: enabled,
			message: enabled ? "Checking readiness" : "",
		});
		async function read() {
			if (flight.current) await flight.current.catch(() => undefined);
			if (cancelled) return;
			attempts += 1;
			setState({
				key,
				readiness: null,
				checking: true,
				message: "Checking readiness",
			});
			const request = getEditReadiness(videoId);
			flight.current = request;
			try {
				const result = await request;
				if (cancelled) return;
				if (result.status !== "ready" || result.readiness.videoId !== videoId) {
					setState({
						key,
						readiness: null,
						checking: false,
						message: "Unable to check readiness",
					});
					return;
				}
				const readiness = result.readiness;
				setState({
					key,
					readiness,
					checking: false,
					message:
						readiness.poll && attempts >= 12
							? readiness.transcriptLabel === "Transcript not started"
								? "Transcript not started. Check again for an update."
								: "Still preparing. Check again for an update."
							: "",
				});
				if (readiness.poll && attempts < 12)
					timer = setTimeout(() => void read(), attempts < 3 ? 5000 : 30000);
			} catch {
				if (!cancelled)
					setState({
						key,
						readiness: null,
						checking: false,
						message: "Unable to check readiness",
					});
			} finally {
				if (flight.current === request) flight.current = null;
			}
		}
		if (enabled) void read();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [key, videoId, enabled]);
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

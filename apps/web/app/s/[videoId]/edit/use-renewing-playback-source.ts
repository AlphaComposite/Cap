"use client";

import { type RefObject, useEffect, useRef, useState } from "react";

export const ORIGINAL_SOURCE_REFRESH_MS = 45 * 60 * 1000;
export const ORIGINAL_SOURCE_RETRY_MS = 60 * 1000;

type RenewingPlaybackSourceOptions = {
	initialSrc: string;
	enabled: boolean;
	videoRef: RefObject<HTMLVideoElement | null>;
	refresh: () => Promise<string | null>;
	refreshMs?: number;
	retryMs?: number;
};

type PendingPlaybackRestore = {
	time: number;
	shouldResume: boolean;
	previousPlayer: HTMLVideoElement;
};

export function useRenewingPlaybackSource({
	initialSrc,
	enabled,
	videoRef,
	refresh,
	refreshMs = ORIGINAL_SOURCE_REFRESH_MS,
	retryMs = ORIGINAL_SOURCE_RETRY_MS,
}: RenewingPlaybackSourceOptions) {
	const [source, setSource] = useState(initialSrc);
	const pendingRestoreRef = useRef<PendingPlaybackRestore | null>(null);

	useEffect(() => {
		setSource(initialSrc);
	}, [initialSrc]);

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		let timeout: ReturnType<typeof setTimeout>;

		const schedule = (delay: number) => {
			timeout = setTimeout(() => void renew(), delay);
		};
		const renew = async () => {
			try {
				const nextSource = await refresh();
				if (cancelled) return;
				if (!nextSource) {
					schedule(retryMs);
					return;
				}

				const player = videoRef.current;
				pendingRestoreRef.current = player
					? {
							time: player.currentTime,
							shouldResume: !player.paused,
							previousPlayer: player,
						}
					: null;
				setSource(nextSource);
				schedule(refreshMs);
			} catch {
				if (!cancelled) schedule(retryMs);
			}
		};

		schedule(refreshMs);
		return () => {
			cancelled = true;
			clearTimeout(timeout);
		};
	}, [enabled, refresh, refreshMs, retryMs, videoRef]);

	useEffect(() => {
		const pending = pendingRestoreRef.current;
		if (!pending) return;
		let cancelled = false;
		let frame = 0;
		let player: HTMLVideoElement | null = null;
		let handleLoadedMetadata: (() => void) | null = null;

		const restore = (current: HTMLVideoElement) => {
			if (cancelled || pendingRestoreRef.current !== pending) return;
			current.currentTime = Math.min(
				pending.time,
				current.duration || pending.time,
			);
			if (pending.shouldResume) void current.play();
			pendingRestoreRef.current = null;
		};
		const bindReplacement = () => {
			const current = videoRef.current;
			const renderedSource =
				current?.getAttribute("src") ?? current?.currentSrc;
			if (
				!current ||
				(current === pending.previousPlayer &&
					renderedSource !== source &&
					current.src !== source)
			) {
				frame = requestAnimationFrame(bindReplacement);
				return;
			}
			player = current;
			handleLoadedMetadata = () => restore(current);
			if (current.readyState >= 1) {
				handleLoadedMetadata();
			} else {
				current.addEventListener("loadedmetadata", handleLoadedMetadata, {
					once: true,
				});
			}
		};

		frame = requestAnimationFrame(bindReplacement);
		return () => {
			cancelled = true;
			cancelAnimationFrame(frame);
			if (player && handleLoadedMetadata) {
				player.removeEventListener("loadedmetadata", handleLoadedMetadata);
			}
		};
	}, [source, videoRef]);

	return source;
}

"use client";

import { useRouter } from "next/navigation";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useTransition,
} from "react";
import { createPortal } from "react-dom";
import EditLoading from "@/app/s/[videoId]/edit/loading";

function OpeningEditor({ href, cancel }: { href: string; cancel: () => void }) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [stalled, setStalled] = useState(false);
	useLayoutEffect(() => {
		const element = dialog.current!;
		element.showModal();
		element.querySelector<HTMLElement>('[role="status"]')?.focus();
		return () => element.close();
	}, []);
	useEffect(() => {
		const timer = setTimeout(() => setStalled(true), 10_000);
		return () => clearTimeout(timer);
	}, []);
	return createPortal(
		<dialog
			ref={dialog}
			aria-label="Opening editor"
			className="fixed inset-0 m-0 h-dvh w-screen max-h-none max-w-none border-0 bg-gray-1 p-0 text-gray-12"
			onCancel={(event) => {
				event.preventDefault();
				cancel();
			}}
		>
			<EditLoading stalled={stalled}>
				<div className="flex gap-4 text-sm">
					{stalled && (
						<a className="underline" href={href}>
							Retry
						</a>
					)}
					<button className="underline" type="button" onClick={cancel}>
						Cancel
					</button>
				</div>
			</EditLoading>
		</dialog>,
		document.body,
	);
}

export function useOpenEditor(videoId: string) {
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [opening, setOpening] = useState(false);
	const active = useRef(false);
	const href = `/s/${videoId}/edit`;
	const dismiss = useCallback(() => {
		active.current = false;
		setOpening(false);
	}, []);
	useEffect(() => {
		if (!pending) dismiss();
	}, [pending, dismiss]);
	useEffect(() => {
		window.addEventListener("popstate", dismiss);
		return () => window.removeEventListener("popstate", dismiss);
	}, [dismiss]);
	const openEditor = () => {
		// A ref also guards two activations before React renders the modal.
		if (active.current) return;
		active.current = true;
		setOpening(true);
		startTransition(async () => {
			try {
				await router.push(href);
			} catch {
				dismiss();
			}
		});
	};
	const cancel = () => {
		dismiss();
		// Supersede the pending Next navigation, including a late RSC response.
		startTransition(() => router.replace(window.location.href));
	};
	return {
		openEditor,
		openingOverlay: opening ? (
			<OpeningEditor href={href} cancel={cancel} />
		) : null,
	};
}

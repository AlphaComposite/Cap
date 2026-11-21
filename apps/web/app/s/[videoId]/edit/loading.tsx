import type { ReactNode } from "react";

export default function EditLoading({
	stalled = false,
	children,
}: {
	stalled?: boolean;
	children?: ReactNode;
}) {
	return (
		<div data-edit-opening="" className="fixed inset-0 z-[100] bg-gray-1">
			<main
				className="mx-auto flex max-w-xl flex-col gap-4 p-8"
				data-edit-opening-focus=""
				tabIndex={-1}
				aria-busy="true"
			>
				<h1 className="text-xl font-medium">
					{stalled ? "Still opening…" : "Opening editor…"}
				</h1>
				<output aria-live="polite" className="text-sm text-gray-11">
					{stalled ? "Still opening…" : "Opening editor…"} Loading your
					recording and timeline.
				</output>
				<div
					aria-hidden="true"
					className="h-2 animate-pulse rounded bg-gray-4"
				/>
				{children}
			</main>
		</div>
	);
}

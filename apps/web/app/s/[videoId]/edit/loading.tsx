export default function EditLoading() {
	return (
		<div data-edit-opening="" className="fixed inset-0 z-[100] bg-gray-1">
			<main
				className="mx-auto flex max-w-xl flex-col gap-4 p-8"
				role="status"
				aria-live="polite"
				aria-busy="true"
			>
				<h1 className="text-xl font-medium">Opening editor…</h1>
				<p className="text-sm text-gray-11">
					Loading your recording and timeline.
				</p>
				<div
					aria-hidden="true"
					className="h-2 animate-pulse rounded bg-gray-4"
				/>
			</main>
		</div>
	);
}

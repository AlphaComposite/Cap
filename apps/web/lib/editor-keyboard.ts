export function isEditorShortcutTarget(
	target: EventTarget | null,
	defaultPrevented = false,
) {
	return (
		defaultPrevented ||
		(target instanceof HTMLElement &&
			target.closest(
				"input, textarea, select, button, a, [role='button'], [role='switch'], [contenteditable='true']",
			) !== null)
	);
}

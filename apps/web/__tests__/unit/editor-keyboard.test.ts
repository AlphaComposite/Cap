// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { isEditorShortcutTarget } from "@/lib/editor-keyboard";

describe("editor keyboard shortcut targeting", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("leaves switches and nested interactive controls to their native keyboard behavior", () => {
		const switchButton = document.createElement("button");
		switchButton.setAttribute("role", "switch");
		const icon = document.createElement("span");
		switchButton.append(icon);
		document.body.append(switchButton);

		expect(isEditorShortcutTarget(switchButton)).toBe(true);
		expect(isEditorShortcutTarget(icon)).toBe(true);
		expect(isEditorShortcutTarget(document.createElement("input"))).toBe(true);
		expect(isEditorShortcutTarget(document.createElement("select"))).toBe(true);
		expect(isEditorShortcutTarget(document.createElement("div"), true)).toBe(
			true,
		);
	});

	it("still allows shortcuts from the non-interactive editor canvas", () => {
		const canvas = document.createElement("div");
		canvas.setAttribute("tabindex", "0");
		document.body.append(canvas);
		expect(isEditorShortcutTarget(canvas)).toBe(false);
	});
});

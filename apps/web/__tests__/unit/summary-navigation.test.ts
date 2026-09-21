// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/app/s/[videoId]/_components/Sidebar";

const summaryHarness = vi.hoisted(() => ({
	state: "dirty" as "clean" | "dirty" | "saving",
	save: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("@/app/Layout/AuthContext", () => ({
	useCurrentUser: () => ({ id: "owner-id" }),
}));

vi.mock("@/app/s/[videoId]/_components/tabs/Activity", async () => {
	const { createElement } = await import("react");
	return { Activity: () => createElement("div", null, "Comments panel") };
});

vi.mock("motion/react", async () => {
	const { createElement } = await import("react");
	const MotionDiv = ({ children, ...props }: Record<string, unknown>) => {
		const {
			animate: _animate,
			custom: _custom,
			exit: _exit,
			initial: _initial,
			layoutId: _layoutId,
			transition: _transition,
			variants: _variants,
			...domProps
		} = props;
		return createElement("div", domProps, children as ReactNode);
	};
	return {
		AnimatePresence: ({ children }: { children: ReactNode }) => children,
		motion: { div: MotionDiv },
	};
});

vi.mock("next/dynamic", async () => {
	const { createElement, useEffect } = await import("react");
	let dynamicCall = 0;
	return {
		default: () => {
			dynamicCall += 1;
			if (dynamicCall === 1) {
				return function MockSummary({
					onEditingStateChange,
					onSaveRequestChange,
				}: {
					onEditingStateChange?: (state: "clean" | "dirty" | "saving") => void;
					onSaveRequestChange?: (
						request: (() => Promise<boolean>) | null,
					) => void;
				}) {
					useEffect(() => {
						onEditingStateChange?.(summaryHarness.state);
						onSaveRequestChange?.(summaryHarness.save);
						return () => onSaveRequestChange?.(null);
					}, [onEditingStateChange, onSaveRequestChange]);
					return createElement("div", null, "Summary editor");
				};
			}
			const label = dynamicCall === 2 ? "Transcript panel" : "Settings panel";
			return () => createElement("div", null, label);
		},
	};
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	summaryHarness.state = "dirty";
	summaryHarness.save.mockReset();
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

const renderSidebar = async (onCollapse = vi.fn()) => {
	await act(async () => {
		root.render(
			createElement(Sidebar, {
				data: {
					id: "video-id",
					owner: { id: "owner-id", isPro: true },
					orgSettings: { disableComments: true },
					duration: 120,
					transcriptionStatus: "COMPLETE",
				} as never,
				commentsData: [],
				optimisticComments: [],
				handleCommentSuccess: vi.fn(),
				setOptimisticComments: vi.fn(),
				setCommentsData: vi.fn(),
				views: 0,
				videoId: "video-id" as never,
				aiData: {
					summary: "Original",
					chapters: [],
					aiGenerationStatus: "COMPLETE",
				},
				onCollapse,
			}),
		);
	});
	return onCollapse;
};

const button = (name: string) => {
	const found = Array.from(container.querySelectorAll("button")).find(
		(element) => element.textContent === name || element.ariaLabel === name,
	);
	if (!found) throw new Error(`Missing button: ${name}`);
	return found;
};

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
};

describe("Summary navigation autosave", () => {
	it("awaits a dirty summary save and then opens the originally clicked tab", async () => {
		const save = deferred<boolean>();
		summaryHarness.save.mockReturnValue(save.promise);
		const confirm = vi.spyOn(window, "confirm");
		await renderSidebar();

		await act(async () => {
			button("Transcript").click();
			button("Transcript").click();
		});

		expect(summaryHarness.save).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("Summary editor");
		expect(confirm).not.toHaveBeenCalled();

		await act(async () => save.resolve(true));

		expect(container.textContent).toContain("Transcript panel");
	});

	it("stays in Summary when the requested save fails", async () => {
		summaryHarness.save.mockResolvedValue(false);
		await renderSidebar();

		await act(async () => button("Transcript").click());

		expect(summaryHarness.save).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("Summary editor");
		expect(container.textContent).not.toContain("Transcript panel");
	});

	it("awaits a dirty summary save and then completes collapse", async () => {
		const save = deferred<boolean>();
		summaryHarness.save.mockReturnValue(save.promise);
		const onCollapse = await renderSidebar();

		await act(async () => button("Hide comments").click());
		expect(onCollapse).not.toHaveBeenCalled();

		await act(async () => save.resolve(true));
		expect(onCollapse).toHaveBeenCalledTimes(1);
	});
});

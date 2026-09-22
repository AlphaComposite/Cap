// @vitest-environment jsdom

import type { Video } from "@cap/web-domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editAiContent } from "@/actions/videos/edit-ai-content";
import { Summary } from "@/app/s/[videoId]/_components/tabs/Summary";
import { SummaryEditor } from "@/app/s/[videoId]/_components/tabs/SummaryEditor";

vi.mock("@/actions/videos/edit-ai-content", () => ({ editAiContent: vi.fn() }));
vi.mock("@cap/ui", async () => ({
	Button: (await import("../../../../packages/ui/src/components/Button"))
		.Button,
}));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
const initialContent = {
	summary: "Original **summary**",
	chapters: [
		{ title: "Introduction", start: 0 },
		{ title: "Next steps", start: 60 },
	],
};
const videoId = "video-id" as Video.VideoId;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	queryClient.setQueryData(["videoStatus", videoId], {
		...initialContent,
		aiGenerationStatus: "COMPLETE",
		name: "Video name",
	});
	localStorage.clear();
	sessionStorage.clear();
	vi.mocked(editAiContent).mockReset();
});

afterEach(async () => {
	await act(async () => root.unmount());
	queryClient.clear();
	container.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const render = async (
	element: ReactNode = createElement(SummaryEditor, {
		videoId,
		initialContent,
		duration: 120,
	}),
) => {
	await act(async () =>
		root.render(
			createElement(QueryClientProvider, { client: queryClient }, element),
		),
	);
};

const change = async (
	element: HTMLInputElement | HTMLTextAreaElement,
	value: string,
) => {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			element instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype,
			"value",
		)?.set;
		setter?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
};

const summary = () => {
	const element = container.querySelector("textarea");
	if (!element) throw new Error("Summary editor missing");
	return element;
};

const status = () => container.querySelector("output")?.textContent;

const chapterInputs = () => ({
	times: Array.from(
		container.querySelectorAll<HTMLInputElement>('input[placeholder="00:00"]'),
	),
	titles: Array.from(
		container.querySelectorAll<HTMLInputElement>(
			'input[placeholder="Chapter title"]',
		),
	),
});

describe("summary autosave editor", () => {
	it("starts clean with a useful vertically resizable Markdown field", async () => {
		await render();
		expect(document.activeElement).toBe(summary());
		expect(summary().rows).toBe(10);
		expect(summary().className).toContain("min-h-48");
		expect(summary().className).toContain("resize-y");
		expect(container.textContent).toContain("Markdown formatting is supported");
		expect(container.textContent).not.toContain("Save changes");
		expect(status()).toContain("All changes saved");
	});

	it("autosaves a large Markdown summary after a short debounce", async () => {
		vi.useFakeTimers();
		const markdown =
			`# Heading\n\n${"large pasted content ".repeat(1_000)}`.trim();
		vi.mocked(editAiContent).mockResolvedValue({
			success: true,
			data: { ...initialContent, summary: markdown },
		});
		await render();
		await change(summary(), markdown);
		expect(status()).toContain("Saving");
		await act(async () => vi.advanceTimersByTimeAsync(699));
		expect(editAiContent).not.toHaveBeenCalled();
		await act(async () => vi.advanceTimersByTimeAsync(1));
		expect(editAiContent).toHaveBeenCalledWith(videoId, {
			expected: initialContent,
			value: { ...initialContent, summary: markdown },
		});
		expect(status()).toContain("Saved");
	});

	it("advances the optimistic concurrency baseline after each save", async () => {
		vi.useFakeTimers();
		vi.mocked(editAiContent)
			.mockResolvedValueOnce({
				success: true,
				data: { ...initialContent, summary: "First" },
			})
			.mockResolvedValueOnce({
				success: true,
				data: { ...initialContent, summary: "Second" },
			});
		await render();
		await change(summary(), "First");
		await act(async () => vi.advanceTimersByTimeAsync(700));
		await change(summary(), "Second");
		await act(async () => vi.advanceTimersByTimeAsync(700));
		expect(editAiContent).toHaveBeenNthCalledWith(2, videoId, {
			expected: { ...initialContent, summary: "First" },
			value: { ...initialContent, summary: "Second" },
		});
	});

	it("lets navigation await the blur save without starting a duplicate", async () => {
		vi.useFakeTimers();
		let finishSave!: () => void;
		const savePending = new Promise<void>((resolve) => {
			finishSave = resolve;
		});
		vi.mocked(editAiContent).mockImplementation(async () => {
			await savePending;
			return {
				success: true,
				data: { ...initialContent, summary: "Draft to keep" },
			};
		});
		let requestSave: (() => Promise<boolean>) | null = null;
		await render(
			createElement(SummaryEditor, {
				videoId,
				initialContent,
				duration: 120,
				onSaveRequestChange: (request) => {
					requestSave = request;
				},
			}),
		);
		await change(summary(), "Draft to keep");
		await act(async () =>
			summary().dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
		);

		let navigationResult: boolean | undefined;
		expect(editAiContent).toHaveBeenCalledTimes(1);
		await act(async () => {
			const navigationSave = requestSave?.();
			finishSave();
			navigationResult = await navigationSave;
		});
		expect(navigationResult).toBe(true);
		expect(editAiContent).toHaveBeenCalledTimes(1);
	});

	it("restores a per-video summary and chapter form draft after remount", async () => {
		vi.useFakeTimers();
		await render();
		await change(summary(), "Recovered summary");
		const chapterTitles = container.querySelectorAll<HTMLInputElement>(
			'input[placeholder="Chapter title"]',
		);
		const firstChapterTitle = chapterTitles[0];
		if (!firstChapterTitle) throw new Error("Chapter title missing");
		await change(firstChapterTitle, "Recovered chapter");

		await act(async () => root.unmount());
		root = createRoot(container);
		await render();

		expect(summary().value).toBe("Recovered summary");
		expect(
			container.querySelectorAll<HTMLInputElement>(
				'input[placeholder="Chapter title"]',
			)[0]?.value,
		).toBe("Recovered chapter");
		expect(localStorage.length).toBe(0);
		expect(sessionStorage.length).toBe(1);
	});

	it("expires a session draft after 24 hours", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		await render();
		await change(summary(), "Expired draft");

		await act(async () => root.unmount());
		root = createRoot(container);
		vi.setSystemTime(new Date("2026-01-02T00:00:00.001Z"));
		await render();

		expect(summary().value).toBe(initialContent.summary);
		expect(sessionStorage.length).toBe(0);
	});

	it("rejects and clears a draft whose server baseline changed", async () => {
		vi.useFakeTimers();
		await render();
		await change(summary(), "Stale draft");

		await act(async () => root.unmount());
		root = createRoot(container);
		const changedBaseline = {
			...initialContent,
			summary: "New server summary",
		};
		await render(
			createElement(SummaryEditor, {
				videoId,
				initialContent: changedBaseline,
				duration: 120,
			}),
		);

		expect(summary().value).toBe("New server summary");
		expect(sessionStorage.length).toBe(0);
	});

	it("stores only a fingerprint of the recovery baseline", async () => {
		vi.useFakeTimers();
		await render();
		await change(summary(), "Draft summary");

		const rawDraft = sessionStorage.getItem("cap:summary-draft:video-id");
		expect(rawDraft).not.toBeNull();
		const draft = JSON.parse(rawDraft ?? "null") as Record<string, unknown>;
		expect(draft).not.toHaveProperty("baseline");
		expect(draft.baselineFingerprint).toEqual(expect.any(String));
	});

	it("clears the recovery draft when edits are reverted to the server baseline", async () => {
		vi.useFakeTimers();
		await render();
		await change(summary(), "Temporary draft");
		expect(sessionStorage.length).toBe(1);

		await change(summary(), initialContent.summary);
		expect(sessionStorage.length).toBe(0);
	});

	it("clears the per-video fallback draft after autosave succeeds", async () => {
		vi.useFakeTimers();
		vi.mocked(editAiContent).mockResolvedValue({
			success: true,
			data: { ...initialContent, summary: "Saved summary" },
		});
		await render();
		await change(summary(), "Saved summary");
		expect(sessionStorage.length).toBe(1);
		expect(localStorage.length).toBe(0);

		await act(async () =>
			summary().dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
		);

		expect(sessionStorage.length).toBe(0);
	});

	it("flushes on blur and preserves a failed draft with an accessible error", async () => {
		vi.useFakeTimers();
		vi.mocked(editAiContent).mockResolvedValue({
			success: false,
			message: "Conflict: content changed",
		});
		await render();
		await change(summary(), "Unsaved **draft**");
		await act(async () =>
			summary().dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
		);
		expect(editAiContent).toHaveBeenCalledTimes(1);
		expect(summary().value).toBe("Unsaved **draft**");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"Error: Conflict",
		);
		expect(status()).toContain("Autosave paused");
	});

	it.each([
		{
			mutation: "timestamp edit",
			mutate: async () => {
				const firstTime = chapterInputs().times[0];
				if (!firstTime) throw new Error("Chapter timestamp missing");
				await change(firstTime, "00:01");
			},
		},
		{
			mutation: "title edit",
			mutate: async () => {
				const firstTitle = chapterInputs().titles[0];
				if (!firstTitle) throw new Error("Chapter title missing");
				await change(firstTitle, "Revised introduction");
			},
		},
		{
			mutation: "chapter removal",
			mutate: async () => {
				const remove = container.querySelector<HTMLButtonElement>(
					'button[aria-label="Remove chapter 2"]',
				);
				if (!remove) throw new Error("Remove chapter button missing");
				await act(async () => remove.click());
			},
		},
		{
			mutation: "chapter addition",
			mutate: async () => {
				const add = Array.from(container.querySelectorAll("button")).find(
					(button) => button.textContent?.includes("Add chapter"),
				);
				if (!add) throw new Error("Add chapter button missing");
				await act(async () => add.click());
				expect(container.textContent).not.toContain(
					"Conflict: content changed",
				);
				const inputs = chapterInputs();
				const addedTime = inputs.times[2];
				const addedTitle = inputs.titles[2];
				if (!addedTime || !addedTitle) throw new Error("Added chapter missing");
				await change(addedTime, "01:30");
				await change(addedTitle, "Conclusion");
			},
		},
	])(
		"resumes autosave after a failed save and $mutation",
		async ({ mutate }) => {
			vi.useFakeTimers();
			vi.mocked(editAiContent)
				.mockResolvedValueOnce({
					success: false,
					message: "Conflict: content changed",
				})
				.mockImplementationOnce(async (_videoId, request) => ({
					success: true,
					data: (request as { value: typeof initialContent }).value,
				}));
			await render();
			await change(summary(), "Unsaved draft");
			await act(async () => vi.advanceTimersByTimeAsync(700));
			expect(status()).toContain("Autosave paused");

			await mutate();
			expect(container.textContent).not.toContain("Conflict: content changed");
			await act(async () => vi.advanceTimersByTimeAsync(700));

			expect(editAiContent).toHaveBeenCalledTimes(2);
			expect(status()).toContain("Saved");
		},
	);

	it("keeps fractional chapter times when only the summary changes", async () => {
		vi.useFakeTimers();
		const content = {
			summary: initialContent.summary,
			chapters: [{ title: "Intro", start: 1.123456 }],
		};
		vi.mocked(editAiContent).mockResolvedValue({
			success: false,
			message: "Try again",
		});
		await render(
			createElement(SummaryEditor, {
				videoId,
				initialContent: content,
				duration: 120,
			}),
		);
		await change(summary(), "Edited summary");
		await act(async () => vi.advanceTimersByTimeAsync(700));
		expect(editAiContent).toHaveBeenCalledWith(videoId, {
			expected: content,
			value: { ...content, summary: "Edited summary" },
		});
	});
});

describe("summary permissions", () => {
	const props: ComponentProps<typeof Summary> = {
		videoId,
		ownerIsPro: true,
		isOwner: true,
		initialAiData: { ...initialContent, aiGenerationStatus: "COMPLETE" },
	};

	it("keeps the manual editor available to the owner when viewer summaries are disabled", async () => {
		await render(createElement(Summary, { ...props, isSummaryDisabled: true }));
		expect(summary().value).toBe(initialContent.summary);
	});

	it("continues hiding disabled summaries from viewers", async () => {
		await render(
			createElement(Summary, {
				...props,
				isOwner: false,
				isSummaryDisabled: true,
			}),
		);
		expect(container.textContent).toBe("");
	});

	it.each([{ isOwner: false }, { ownerIsPro: false }])(
		"does not expose editing when unavailable",
		async (overrides) => {
			await render(createElement(Summary, { ...props, ...overrides }));
			expect(container.querySelector("textarea")).toBeNull();
		},
	);

	it("keeps the manual summary editor available while chapters generate", async () => {
		await render(
			createElement(Summary, {
				...props,
				initialAiData: {
					...initialContent,
					aiGenerationStatus: "PROCESSING",
				},
			}),
		);
		expect(summary().value).toBe(initialContent.summary);
	});

	it("uses chapter-generation copy for an unavailable automatic result", async () => {
		await render(
			createElement(Summary, {
				...props,
				isOwner: false,
				initialAiData: {
					summary: null,
					chapters: [],
					aiGenerationStatus: "ERROR",
				},
			}),
		);
		expect(container.textContent).toContain("automatic chapters");
		expect(container.textContent).not.toContain("AI summary");
	});

	it("keeps viewer chapter controls keyboard accessible", async () => {
		const onSeek = vi.fn();
		await render(createElement(Summary, { ...props, isOwner: false, onSeek }));
		const chapter = Array.from(container.querySelectorAll("button")).find(
			(node) => node.textContent?.includes("Next steps"),
		);
		await act(async () => chapter?.click());
		expect(onSeek).toHaveBeenCalledWith(60);
	});
});

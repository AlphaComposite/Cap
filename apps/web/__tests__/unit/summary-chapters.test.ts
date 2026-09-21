// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import SummaryChapters from "@/app/s/[videoId]/_components/SummaryChapters";

const actEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const aiData = {
	title: null,
	summary: "A **clear** public summary.",
	chapters: [
		{ title: "Introduction", start: 5 },
		{ title: "Main idea", start: 65 },
	],
	aiGenerationStatus: "COMPLETE" as const,
};

describe("SummaryChapters", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	afterAll(() => {
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	async function render(
		overrides: Partial<React.ComponentProps<typeof SummaryChapters>> = {},
	) {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root.render(
				createElement(SummaryChapters, {
					isSummaryDisabled: false,
					areChaptersDisabled: false,
					handleSeek: vi.fn(),
					aiData,
					aiLoading: false,
					...overrides,
				}),
			);
		});
	}

	it("renders enabled chapters independently and seeks from timestamp buttons", async () => {
		const handleSeek = vi.fn();
		await render({
			isSummaryDisabled: true,
			handleSeek,
		});

		const chapters = container.querySelector('[data-testid="public-chapters"]');
		expect(
			container.querySelector('[data-testid="public-summary"]'),
		).toBeNull();
		expect(chapters?.textContent).toContain("Chapters");
		const buttons = Array.from(chapters?.querySelectorAll("button") ?? []);
		expect(buttons.map((button) => button.textContent)).toEqual([
			expect.stringContaining("00:05"),
			expect.stringContaining("01:05"),
		]);

		await act(async () => buttons[1]?.click());
		expect(handleSeek).toHaveBeenCalledOnce();
		expect(handleSeek).toHaveBeenCalledWith(65);
	});

	it("uses a flat readable layout with Summary before Chapters", async () => {
		await render();

		const summary = container.querySelector('[data-testid="public-summary"]');
		const chapters = container.querySelector('[data-testid="public-chapters"]');
		const layout = summary?.parentElement;

		expect(layout?.className).toContain("max-w-3xl");
		expect(layout?.className).toContain("sm:px-4");
		expect(layout?.className).not.toContain("rounded");
		expect(layout?.className).not.toContain("border");
		expect(layout?.className).not.toContain("bg-white");
		expect(summary?.querySelector("h2")?.textContent).toBe("Summary");
		expect(chapters?.querySelector("h2")?.textContent).toBe("Chapters");
		if (!chapters) throw new Error("Missing public chapters section");
		expect(
			Boolean(
				(summary?.compareDocumentPosition(chapters) ?? 0) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			),
		).toBe(true);
	});

	it("omits explicitly disabled sections even when data is present", async () => {
		await render({
			isSummaryDisabled: true,
			areChaptersDisabled: true,
		});

		expect(
			container.querySelector('[data-testid="public-summary"]'),
		).toBeNull();
		expect(
			container.querySelector('[data-testid="public-chapters"]'),
		).toBeNull();
		expect(container.textContent).toBe("");
	});

	it("renders enabled summary markdown without chapters", async () => {
		await render({
			areChaptersDisabled: true,
		});

		const summary = container.querySelector('[data-testid="public-summary"]');
		expect(summary?.textContent).toContain("Summary");
		expect(summary?.querySelector("strong")?.textContent).toBe("clear");
		expect(
			container.querySelector('[data-testid="public-chapters"]'),
		).toBeNull();
	});
});

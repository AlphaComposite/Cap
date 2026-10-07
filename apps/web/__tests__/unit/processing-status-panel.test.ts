// @vitest-environment jsdom

import { Provider as TooltipProvider } from "@radix-ui/react-tooltip";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessingStatusPanel } from "@/app/s/[videoId]/_components/ProcessingStatusPanel";
import { ShareHeader } from "@/app/s/[videoId]/_components/ShareHeader";
import type { EditReadiness } from "@/lib/video-edit-readiness";

const harness = vi.hoisted(() => ({
	readiness: null as EditReadiness | null,
	user: { id: "owner-id", isPro: true },
	push: vi.fn(),
	refresh: vi.fn(),
	checkAgain: vi.fn(),
	invalidateQueries: vi.fn(),
	retryProcessing: vi.fn(),
	toast: vi.fn(),
}));

vi.mock("@cap/env", () => ({ buildEnv: {}, NODE_ENV: "test" }));
vi.mock("@cap/ui", async () => {
	const { Button } = await vi.importActual<{
		Button: typeof import("@cap/ui").Button;
	}>("../../../../packages/ui/src/components/Button");
	const menu = await import("@radix-ui/react-dropdown-menu");
	return {
		Button,
		Logo: () => null,
		DropdownMenu: menu.Root,
		DropdownMenuContent: menu.Content,
		DropdownMenuItem: menu.Item,
		DropdownMenuSeparator: menu.Separator,
		DropdownMenuTrigger: menu.Trigger,
	};
});
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: harness.invalidateQueries }),
	useQuery: () => ({ data: undefined }),
	skipToken: Symbol(),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: harness.push, refresh: harness.refresh }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("sonner", () => ({ toast: { success: harness.toast } }));
vi.mock("@/actions/video/retry-processing", () => ({
	retryVideoProcessing: harness.retryProcessing,
}));
vi.mock("@/actions/organization/shareable-link-icon", () => ({}));
vi.mock("@/actions/videos/edit-title", () => ({}));
vi.mock("@/app/(org)/dashboard/DashboardContext", () => ({
	useDashboardContext: () => null,
}));
vi.mock("@/app/Layout/AuthContext", () => ({
	useCurrentUser: () => harness.user,
}));
vi.mock("@/components/SignedImageUrl", () => ({ SignedImageUrl: () => null }));
vi.mock("@/lib/video-share-clipboard", () => ({}));
vi.mock("@/utils/public-env", () => ({
	usePublicEnv: () => ({ webUrl: "https://cap.test" }),
}));
vi.mock("@/utils/view-transition", () => ({
	navigateWithTransition: (_name: string, navigate: () => void) => navigate(),
}));
vi.mock("../../hooks/use-edit-readiness", () => ({
	useEditReadiness: () => ({
		readiness: harness.readiness,
		checking: false,
		message: "Checking readiness",
		checkAgain: harness.checkAgain,
	}),
}));
vi.mock("@/app/s/[videoId]/_components/use-video-download", () => ({
	useVideoDownload: () => ({}),
}));
vi.mock("@/app/s/[videoId]/_components/VideoDownloadMenu", () => ({
	VideoDownloadMenu: () => null,
}));

const readiness = (overrides: Partial<EditReadiness> = {}): EditReadiness => ({
	videoId: "video-id",
	identity: "source",
	playbackAdmission: true,
	playbackVerified: false,
	manualEditing: false,
	transcriptUsable: false,
	videoState: "processed",
	videoLabel: "Video processed",
	transcriptLabel: "Transcribing",
	poll: true,
	editorOpenable: false,
	uploadPhase: "complete",
	transcriptionStatus: "PROCESSING",
	aiGenerationStatus: "QUEUED",
	sourcePrepare: "running",
	processingSummary: "Preparing for editing. Transcript is running.",
	allDone: false,
	rows: [
		{ id: "upload", label: "Uploaded", state: "done" },
		{ id: "video", label: "Video processed", state: "done" },
		{ id: "transcript", label: "Transcript", state: "running" },
		{ id: "ai", label: "Summary and chapters", state: "waiting" },
		{ id: "sourcePrepare", label: "Preparing for editing", state: "running" },
	],
	...overrides,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	harness.user = { id: "owner-id", isPro: true };
	harness.readiness = readiness();
	harness.invalidateQueries.mockResolvedValue(undefined);
	harness.retryProcessing.mockResolvedValue({
		success: true,
		status: "started",
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

const renderPanel = async (
	value: EditReadiness | null,
	videoId = "video-id",
) => {
	await act(async () => {
		root.render(
			createElement(ProcessingStatusPanel, {
				videoId: videoId as never,
				state: {
					readiness: value,
					checking: false,
					message: "Checking readiness",
					checkAgain: harness.checkAgain,
				},
			}),
		);
	});
};

const renderHeader = async () => {
	await act(async () => {
		root.render(
			createElement(
				TooltipProvider,
				null,
				createElement(ShareHeader, {
					data: {
						id: "video-id",
						name: "A recording",
						owner: { id: "owner-id", name: "Owner", isPro: true },
						createdAt: new Date(),
						source: { type: "webMP4" },
						isScreenshot: false,
					} as never,
				}),
			),
		);
	});
};

const click = async (element: Element | null) => {
	if (!element) throw new Error("Missing clickable element");
	await act(async () => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
};

const editButton = () =>
	Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent?.trim() === "Edit video",
	);

describe("ProcessingStatusPanel", () => {
	it("keeps the step list out of live announcements and shows the preparation estimate", async () => {
		await renderPanel(readiness());
		expect(container.querySelector("output")?.getAttribute("aria-live")).toBe(
			"off",
		);
		expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
			readiness().processingSummary,
		);
		expect(container.querySelectorAll("li")).toHaveLength(5);
		expect(container.textContent).toContain("Processing…");
		expect(container.textContent).toContain("Usually takes about 1–2 min.");
		expect(container.textContent).toContain("waiting");
		expect(container.textContent).toContain("running");
		expect(container.textContent).toContain("done");
	});

	it("announces one observed false-to-true transition, never initial readiness", async () => {
		await renderPanel(readiness({ editorOpenable: true }));
		expect(harness.toast).not.toHaveBeenCalled();
		await renderPanel(readiness());
		await renderPanel(null);
		await renderPanel(readiness({ editorOpenable: true }));
		await renderPanel(readiness());
		await renderPanel(readiness({ editorOpenable: true }));
		expect(harness.toast).toHaveBeenCalledExactlyOnceWith("Ready to edit");
		await renderPanel(readiness({ editorOpenable: true }), "another-video");
		expect(harness.toast).toHaveBeenCalledTimes(1);
	});

	it("retains background steps when editing is ready and collapses only when all done", async () => {
		await renderPanel(readiness({ editorOpenable: true }));
		expect(container.querySelector("h2")?.textContent).toBe("Ready to edit");
		expect(container.querySelectorAll("li")).toHaveLength(5);
		await renderPanel(readiness({ editorOpenable: true, allDone: true }));
		expect(container.querySelector("ul")).toBeNull();
		expect(container.querySelector("h2")?.textContent).toBe("Ready to edit");
	});

	it.each(["processing", "transcript", "ai"] as const)(
		"retries supported %s failures and invalidates the existing caches",
		async (retry) => {
			const fetch = vi.fn().mockResolvedValue({ ok: true });
			vi.stubGlobal("fetch", fetch);
			await renderPanel(
				readiness({
					rows: [
						{
							id: "video",
							label: "Video processed",
							state: "failed",
							reason: "Could not process video",
							retry,
						},
						{
							id: "sourcePrepare",
							label: "Preparing for editing",
							state: "failed",
							reason: "Source unavailable",
							retry: "processing",
						},
					],
				}),
			);
			expect(container.querySelectorAll('[role="alert"]')).toHaveLength(2);
			expect(container.querySelectorAll("button")).toHaveLength(1);
			expect(container.textContent).toContain("Could not process video");
			await click(container.querySelector("button"));
			if (retry === "processing") {
				expect(harness.retryProcessing).toHaveBeenCalledWith({
					videoId: "video-id",
				});
				expect(harness.invalidateQueries).toHaveBeenCalledWith({
					queryKey: ["getUploadProgress", "video-id"],
				});
				expect(fetch).not.toHaveBeenCalled();
			} else {
				expect(fetch).toHaveBeenCalledWith(
					`/api/videos/video-id/retry-${retry === "transcript" ? "transcription" : "ai"}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
					},
				);
				if (retry === "transcript")
					expect(harness.invalidateQueries).toHaveBeenCalledWith({
						queryKey: ["transcript", "video-id"],
					});
			}
			expect(harness.invalidateQueries).toHaveBeenCalledWith({
				queryKey: ["videoStatus", "video-id"],
			});
			expect(harness.checkAgain).toHaveBeenCalledTimes(1);
			expect(harness.refresh).toHaveBeenCalledTimes(1);
		},
	);

	it("reports retry errors without claiming the work restarted", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
		await renderPanel(
			readiness({
				rows: [
					{
						id: "transcript",
						label: "Transcript",
						state: "failed",
						retry: "transcript",
					},
				],
			}),
		);
		await click(container.querySelector("button"));
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"Could not retry. Please try again.",
		);
		expect(harness.checkAgain).not.toHaveBeenCalled();
	});
});

describe("share editing controls", () => {
	it("shows the panel only to the owner and Edit only for playable videos", async () => {
		harness.user.id = "viewer-id";
		await renderHeader();
		expect(container.querySelector("output")).toBeNull();
		expect(editButton()).toBeUndefined();
		harness.user.id = "owner-id";
		harness.readiness = readiness({ playbackAdmission: false });
		await renderHeader();
		expect(container.querySelectorAll("output")).toHaveLength(1);
		expect(editButton()).toBeUndefined();
	});

	it("keeps Edit focusable, explains the gate on focus, and opens only when ready", async () => {
		await renderHeader();
		const button = editButton();
		if (!button) throw new Error("Missing Edit video button");
		expect(button.disabled).toBe(false);
		expect(button.getAttribute("aria-disabled")).toBe("true");
		await act(async () => button.focus());
		expect(document.activeElement).toBe(button);
		expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
			"Available when 'Preparing for editing' finishes",
		);
		await click(button);
		expect(harness.push).not.toHaveBeenCalled();
		harness.readiness = readiness({ editorOpenable: true });
		await renderHeader();
		await click(editButton() ?? null);
		expect(harness.push).toHaveBeenCalledExactlyOnceWith("/s/video-id/edit");
	});

	it("uses the same gate for the mobile Manage Cap menu", async () => {
		await renderHeader();
		const trigger = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Manage Cap",
		);
		if (!trigger) throw new Error("Missing Manage Cap trigger");
		await act(async () => {
			trigger.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			);
		});
		const item = Array.from(
			container.querySelectorAll('[role="menuitem"]'),
		).find((item) => item.textContent?.trim() === "Edit video");
		expect(item?.getAttribute("aria-disabled")).toBe("true");
		await click(item ?? null);
		expect(harness.push).not.toHaveBeenCalled();
		expect(container.querySelector('[role="menu"]')).not.toBeNull();
		harness.readiness = readiness({ editorOpenable: true });
		await renderHeader();
		await click(
			Array.from(container.querySelectorAll('[role="menuitem"]')).find(
				(item) => item.textContent?.trim() === "Edit video",
			) ?? null,
		);
		expect(harness.push).toHaveBeenCalledExactlyOnceWith("/s/video-id/edit");
	});
});

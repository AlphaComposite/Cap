// @vitest-environment jsdom

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Video } from "@cap/web-domain";
import { Effect, Layer } from "effect";
import {
	handleClientScriptLoad,
	type ScriptProps,
} from "next/dist/client/script";
import {
	act,
	Children,
	type ComponentProps,
	createElement,
	isValidElement,
} from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CapCardContent } from "@/app/(org)/dashboard/caps/components/CapCard/CapCardContent";
import { Stepper } from "@/app/(org)/dashboard/settings/organization/components/CustomDomainDialog/Stepper";
import { StepStatus } from "@/app/(org)/dashboard/settings/organization/components/CustomDomainDialog/types";
import OrgName from "@/app/(org)/dashboard/settings/organization/components/OrgName";
import { RecordScreenMacStructuredData } from "@/components/blog/RecordScreenMacStructuredData";
import LeftLight from "@/components/pages/HomePage/LeftLight";
import RecordingModes from "@/components/pages/HomePage/RecordingModes";
import { ComparisonSlider } from "@/components/seo/ComparisonSlider";
import { MediaFormatConverter } from "@/components/tools/MediaFormatConverter";
import { ThumbnailRequest } from "@/lib/Requests/ThumbnailRequest";
import { Rpc } from "@/lib/Rpcs";
import resolver from "../../../../packages/config/vite/relativeAliasResolver";
import { Button as SharedButton } from "../../../../packages/ui/src/components/Button";
import { recordScreenMacContent } from "../../content/blog-content/record-screen-mac-system-audio";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("next/image", () => ({ default: () => null }));

vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		activeOrganization: { organization: { name: "Team", id: "team" } },
		user: { isPro: true },
	}),
}));
vi.mock("@/actions/organization/update-details", () => ({
	updateOrganizationDetails: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: vi.fn() }),
	usePathname: () => "/tools/convert/mp4-to-gif",
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/actions/videos/edit-date", () => ({ editDate: vi.fn() }));
vi.mock("@/actions/videos/edit-title", () => ({ editTitle: vi.fn() }));
vi.mock("@/components/Tooltip", () => ({
	Tooltip: ({ children }: ComponentProps<"div">) => children,
}));
vi.mock("hooks/useDetectPlatform", () => ({
	useDetectPlatform: () => ({ platform: null, isIntel: false }),
}));
vi.mock("@/components/pages/_components/UpgradeToPro", () => ({
	default: () => null,
}));
vi.mock("@cap/ui", () => ({
	Input: (props: ComponentProps<"input">) => createElement("input", props),
	Label: (props: ComponentProps<"label">) => createElement("label", props),
	Button: ({
		spinner,
		variant,
		size,
		...props
	}: ComponentProps<"button"> & {
		spinner?: boolean;
		variant?: string;
		size?: string;
	}) => createElement("button", { type: "button", ...props }),
}));

describe("lint batch A semantics", () => {
	it("keeps slotted links native while retaining icons and shortcut content", () => {
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(
			createElement(
				SharedButton,
				{
					asChild: true,
					target: "_blank",
					icon: createElement("span", null, "Icon"),
					kbd: "K",
					className: "custom-button",
				},
				createElement("a", { href: "/download" }, "Download"),
			),
		);
		const link = host.querySelector("a");
		expect(link?.getAttribute("href")).toBe("/download");
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.className).toContain("custom-button");
		expect(link?.textContent).toBe("IconDownloadK");
		expect(host.querySelector("button")).toBeNull();
	});

	it("fails a missing thumbnail reply instead of leaving its request pending", async () => {
		const request = Effect.gen(function* () {
			const resolver = yield* ThumbnailRequest.DataLoaderResolver;
			return yield* Effect.request(
				new ThumbnailRequest.ThumbnailRequest({
					videoId: Video.VideoId.make("video0000001"),
				}),
				resolver,
			);
		}).pipe(
			Effect.provide(
				ThumbnailRequest.DataLoaderResolver.DefaultWithoutDependencies,
			),
			Effect.provide(
				Layer.mock(Rpc, {
					_tag: "Rpc",
					VideosGetThumbnails: vi.fn().mockReturnValue(Effect.succeed([])),
				}),
			),
			Effect.timeoutFail({
				duration: "150 millis",
				onTimeout: () => new Error("thumbnail timeout"),
			}),
			Effect.scoped,
		);
		await expect(Effect.runPromise(request)).rejects.toThrow(
			"Missing thumbnail response",
		);
	});

	it("provides a focusable native comparison range with bounded values", () => {
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(
			createElement(ComparisonSlider, {
				leftImage: "/left.png",
				rightImage: "/right.png",
				leftAlt: "Before",
				rightAlt: "After",
				leftLabel: "Cap",
				rightLabel: "Other",
			}),
		);
		const slider = host.querySelector('input[type="range"]');
		expect(slider?.getAttribute("aria-label")).toBe("Compare Cap and Other");
		expect(slider?.getAttribute("min")).toBe("0");
		expect(slider?.getAttribute("max")).toBe("100");
		expect(slider?.getAttribute("value")).toBe("50");
	});

	it("associates GIF settings with controls and keeps file selection outside the browse button", () => {
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(
			createElement(MediaFormatConverter, {
				initialConversionPath: "mp4-to-gif",
			}),
		);
		const labels = [...host.querySelectorAll("label")].filter(
			(label) => !label.textContent?.includes("Dithering"),
		);
		expect(labels).toHaveLength(3);
		for (const label of labels) {
			expect(label.control).toBeInstanceOf(HTMLInputElement);
			if (label.control instanceof HTMLInputElement)
				expect(label.control.type).toBe("range");
		}
		const browse = host.querySelector('button[aria-label="Select MP4 file"]');
		expect(browse).not.toBeNull();
		expect(browse?.querySelector("input")).toBeNull();
	});

	it("exposes sharing and title editing as native controls", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const share = vi.fn();
		try {
			await act(async () =>
				root.render(
					createElement(CapCardContent, {
						cap: {
							id: Video.VideoId.make("video0000001"),
							name: "Demo title",
							ownerId: "owner",
							ownerName: "Owner",
							createdAt: new Date(0),
							totalComments: 0,
							totalReactions: 0,
							hasActiveUpload: false,
						},
						userId: "owner",
						isOwner: true,
						setIsSharingDialogOpen: share,
					}),
				),
			);
			const sharing = [...host.querySelectorAll("button")].find((button) =>
				button.textContent?.includes("Not shared"),
			);
			expect(sharing?.type).toBe("button");
			await act(async () => sharing?.click());
			expect(share).toHaveBeenCalledWith(true);
			const title = [...host.querySelectorAll("button")].find(
				(button) => button.textContent === "Demo title",
			);
			expect(title?.type).toBe("button");
			await act(async () => title?.click());
			expect(host.querySelector("textarea")?.value).toBe("Demo title");
			expect(document.activeElement).toBe(host.querySelector("textarea"));
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});

	it("rejects missing importers before filesystem resolution", async () => {
		if (typeof resolver.customResolver !== "function")
			throw new Error("Missing resolver");
		await expect(
			Reflect.apply(resolver.customResolver, null, ["~/missing", undefined]),
		).rejects.toThrow("Cannot resolve ~/missing without an importer");
	});

	it("resolves existing alias files and rejects missing targets", async () => {
		if (typeof resolver.customResolver !== "function") {
			throw new Error("Missing alias resolver");
		}
		const directory = await mkdtemp(path.join(tmpdir(), "cap-lint-alias-"));
		try {
			await mkdir(path.join(directory, "src"));
			await mkdir(path.join(directory, "nested"));
			await writeFile(path.join(directory, "package.json"), "{}");
			await writeFile(path.join(directory, "src", "component.tsx"), "");
			await writeFile(path.join(directory, "component.tsx"), "");
			for (const folder of ["src", "nested"]) {
				expect(
					await Reflect.apply(resolver.customResolver, null, [
						"~/component",
						path.join(directory, folder, "entry.ts"),
					]),
				).toBe(
					path.join(directory, folder === "src" ? "src" : "", "component.tsx"),
				);
			}
			await expect(
				Reflect.apply(resolver.customResolver, null, [
					"~/missing",
					path.join(directory, "src", "entry.ts"),
				]),
			).rejects.toThrow("Failed to resolve import path ~/missing");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("switches recording demos through named native buttons", async () => {
		const host = document.createElement("div");
		const root = createRoot(host);
		try {
			await act(async () => root.render(createElement(RecordingModes)));
			const studio = [...host.querySelectorAll("button")].find((button) =>
				button.textContent?.includes("Studio Mode"),
			);
			expect(studio?.type).toBe("button");
			await act(async () => studio?.click());
			expect(studio?.getAttribute("aria-pressed")).toBe("true");
			expect(host.querySelector("iframe")?.title).toBe("Studio Mode demo");
			expect(host.querySelector("iframe")?.src).toBe(
				"https://cap.so/embed/qk8gt56e1q1r735",
			);
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("connects labels to the input in each repeated organization form", () => {
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(
			createElement(
				"div",
				null,
				createElement(OrgName),
				createElement(OrgName),
			),
		);
		const inputs = [...host.querySelectorAll("input")];
		expect(new Set(inputs.map((input) => input.id)).size).toBe(2);
		const labels = [...host.querySelectorAll("label")];
		for (const [index, label] of labels.entries()) {
			expect(label.control).toBe(inputs[index]);
		}
	});

	it("preserves JSON-LD values and Next Script deduplication at hostile boundaries", async () => {
		const title = recordScreenMacContent.title;
		const hostile = "</ScRiPt><img src=x onerror=alert(1)> & \u2028\u2029";
		recordScreenMacContent.title = hostile;
		try {
			const scripts = Children.toArray(
				RecordScreenMacStructuredData().props.children,
			);
			for (const script of scripts) {
				if (!isValidElement<ScriptProps>(script))
					throw new Error("Expected a script");
				handleClientScriptLoad(script.props);
			}
			const script = document.getElementById(
				"blog-record-screen-mac-system-audio-article-structured-data",
			);
			expect(script?.getAttribute("type")).toBe("application/ld+json");
			const text = script?.textContent ?? "";
			expect(JSON.parse(text).headline).toBe(hostile);
			expect(text).not.toContain("<");
			expect(text).not.toContain("&");
			expect(text).not.toContain("\u2028");
			expect(text).not.toContain("\u2029");
			const serverMarkup = document.createElement("div");
			serverMarkup.innerHTML = renderToStaticMarkup(
				createElement("script", { type: "application/ld+json" }, text),
			);
			expect(serverMarkup.querySelectorAll("script")).toHaveLength(1);
			expect(serverMarkup.querySelector("img")).toBeNull();
			expect(
				JSON.parse(serverMarkup.querySelector("script")?.textContent ?? "")
					.headline,
			).toBe(hostile);
			for (const script of scripts) {
				if (!isValidElement<ScriptProps>(script))
					throw new Error("Expected a script");
				handleClientScriptLoad(script.props);
			}
			expect(
				document.querySelectorAll(
					"#blog-record-screen-mac-system-audio-article-structured-data",
				),
			).toHaveLength(1);
		} finally {
			recordScreenMacContent.title = title;
		}
	});

	it("pairs each decorative light definition with its own reference", () => {
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(
			createElement(
				"div",
				null,
				createElement(LeftLight),
				createElement(LeftLight),
			),
		);
		const ids = [...host.querySelectorAll("[id]")].map((node) => node.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const svg of host.querySelectorAll("svg")) {
			expect(svg.getAttribute("aria-hidden")).toBe("true");
			for (const node of svg.querySelectorAll("[filter], [fill]")) {
				const reference =
					node.getAttribute("filter") ?? node.getAttribute("fill");
				if (!reference?.startsWith("url(#")) continue;
				expect(
					[...svg.querySelectorAll("[id]")].some(
						(target) => target.id === reference.slice(5, -1),
					),
				).toBe(true);
			}
		}
	});

	it("makes only completed steps actionable without submitting a form", async () => {
		const onStepClick = vi.fn();
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () =>
				root.render(
					createElement(Stepper, {
						steps: [
							{ id: "domain", name: "Domain", status: StepStatus.COMPLETED },
							{ id: "verify", name: "Verify", status: StepStatus.PENDING },
						],
						onStepClick,
					}),
				),
			);
			const buttons = host.querySelectorAll("button");
			expect(buttons).toHaveLength(2);
			const [completed, pending] = buttons;
			expect(completed?.textContent).toContain("Domain");
			expect(completed?.type).toBe("button");
			completed?.focus();
			expect(document.activeElement).toBe(completed);
			await act(async () => completed?.click());
			expect(onStepClick).toHaveBeenCalledExactlyOnceWith(0);
			expect(pending?.disabled).toBe(true);
			await act(async () => pending?.click());
			expect(onStepClick).toHaveBeenCalledTimes(1);
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});
});

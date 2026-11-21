// @vitest-environment jsdom

import { MediaContext } from "media-chrome/react/media-store";
import { handleClientScriptLoad } from "next/dist/client/script";
import {
	act,
	Children,
	createElement,
	type InputHTMLAttributes,
	isValidElement,
	type ReactNode,
	useContext,
} from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("@cap/ui", async () => {
	const React = await import("react");
	const wrapper = ({ children }: { children?: ReactNode }) => children;
	return {
		Button: ({
			children,
			onClick,
			disabled,
		}: {
			children?: ReactNode;
			onClick?: () => void;
			disabled?: boolean;
		}) => React.createElement("button", { onClick, disabled }, children),
		Input: React.forwardRef<
			HTMLInputElement,
			InputHTMLAttributes<HTMLInputElement>
		>((props, ref) => React.createElement("input", { ...props, ref })),
		LoadingSpinner: () => null,
		Dialog: wrapper,
		DialogContent: wrapper,
		DialogFooter: wrapper,
		DialogHeader: wrapper,
		DialogTitle: wrapper,
	};
});
vi.mock("@cap/web-domain", () => ({
	ImageUpload: { ImageUrl: { make: (value: string) => value } },
	Organisation: { OrganisationId: { make: (value: string) => value } },
}));
vi.mock("@/components/SignedImageUrl", () => ({ SignedImageUrl: () => null }));
vi.mock("@/components/Tooltip", () => ({
	Tooltip: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/components/seo/SeoPageTemplate", () => ({
	SeoPageTemplate: () => null,
}));
vi.mock("@/components/tools/MediaFormatConverter", () => ({
	MediaFormatConverter: () => null,
}));
vi.mock("@/lib/og/url", () => ({ ogImageUrl: () => "/og-fixture" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/actions/organization/check-domain", () => ({
	checkOrganizationDomain: vi.fn(),
}));
vi.mock("@/actions/organization/remove-domain", () => ({
	removeOrganizationDomain: vi.fn(),
}));
vi.mock("@/actions/organization/update-domain", () => ({
	updateDomain: vi.fn(),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		user: { isPro: true },
		activeOrganization: {
			organization: { id: "org", customDomain: "cap.example" },
		},
	}),
}));
vi.mock("@/app/(org)/dashboard/_components/Confetti", () => ({
	Confetti: () => null,
}));
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/CustomDomainDialog/DomainStep",
	() => ({ default: () => null }),
);
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/CustomDomainDialog/VerifyStep",
	() => ({ default: () => null }),
);
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/CustomDomainDialog/SuccessStep",
	() => ({ default: () => null }),
);
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/CustomDomainDialog/SubscribeContent",
	() => ({ default: () => null }),
);
vi.mock(
	"@/app/(org)/dashboard/settings/organization/components/CustomDomainDialog/Stepper",
	async () => {
		const React = await import("react");
		return {
			Stepper: ({ onStepClick }: { onStepClick: (index: number) => void }) =>
				React.createElement(
					"button",
					{ onClick: () => onStepClick(0) },
					"Domain step",
				),
		};
	},
);

import CustomDomainDialog from "../../app/(org)/dashboard/settings/organization/components/CustomDomainDialog/CustomDomainDialog";
import AVIToMP4Page from "../../app/(site)/tools/convert/avi-to-mp4/page";
import {
	MediaPlayer,
	MediaPlayerLoading,
	MediaPlayerPiP,
	MediaPlayerPlay,
	MediaPlayerSeekBackward,
	MediaPlayerSeekForward,
} from "../../app/s/[videoId]/_components/video/media-player";
import { FileInput } from "../../components/FileInput";
import LeftBlueHue from "../../components/pages/HomePage/LeftBlueHue";
import {
	DailyStandupSoftwarePage,
	dailyStandupSoftwareContent,
} from "../../components/pages/seo/DailyStandupSoftwarePage";
import { ToolsPageTemplate } from "../../components/tools/ToolsPageTemplate";
import { TrimmingTool } from "../../components/tools/TrimmingTool";

const roots: ReturnType<typeof createRoot>[] = [];
function LoadingFixture() {
	const store = useContext(MediaContext);
	if (!store) throw new Error("Expected a media store");
	return createElement(
		MediaContext.Provider,
		{
			value: {
				...store,
				getState: () => ({
					...store.getState(),
					mediaLoading: true,
					mediaPaused: false,
				}),
			},
		},
		createElement(MediaPlayerLoading, null, "Custom loading"),
	);
}

function mount(node: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	act(() => root.render(node));
	return { container, root };
}

afterEach(() => {
	act(() => {
		for (const root of roots.splice(0)) root.unmount();
	});
	document.body.replaceChildren();
	vi.useRealTimers();
});

describe("lint batch B behavior", () => {
	it("preserves raw JSON-LD script semantics during server rendering", () => {
		const scripts = Children.toArray(AVIToMP4Page().props.children).filter(
			(node) => isValidElement(node) && node.type === "script",
		);
		expect(scripts).toHaveLength(3);
		for (const script of scripts) {
			const container = document.createElement("div");
			container.innerHTML = renderToStaticMarkup(script);
			const rendered = container.querySelector("script");
			expect(rendered?.type).toBe("application/ld+json");
			expect(JSON.parse(rendered?.textContent ?? "")).toHaveProperty("@type");
		}
	});

	it("preserves custom player controls without nesting interactive buttons", () => {
		const { container } = mount(
			createElement(
				MediaPlayer,
				null,
				[MediaPlayerPlay, MediaPlayerSeekBackward, MediaPlayerSeekForward].map(
					(Control, index) =>
						createElement(
							Control,
							{ key: Control.name, asChild: true },
							createElement("button", { type: "button" }, `Custom ${index}`),
						),
				),
				createElement(MediaPlayerPiP, null, "Custom PiP"),
				createElement(LoadingFixture),
			),
		);
		expect(container.querySelector("button button")).toBeNull();
		expect(container.querySelectorAll("button")).toHaveLength(4);
		expect(container.textContent).toContain("Custom PiP");
		expect(container.textContent).toContain("Custom loading");
	});

	it("keeps the trimmer's active source alive across renders and revokes it on replacement/unmount", () => {
		vi.useFakeTimers();
		let dragListeners = 0;
		const add = window.addEventListener.bind(window);
		vi.spyOn(window, "addEventListener").mockImplementation(
			(...args: Parameters<typeof window.addEventListener>) => {
				if (args[0] === "dragover") {
					dragListeners += 1;
					expect(dragListeners).toBeLessThan(3);
				}
				add(...args);
			},
		);
		Object.defineProperty(URL, "createObjectURL", {
			configurable: true,
			value: vi
				.fn()
				.mockReturnValueOnce("blob:first")
				.mockReturnValueOnce("blob:second"),
		});
		Object.defineProperty(URL, "revokeObjectURL", {
			configurable: true,
			value: vi.fn(),
		});
		const { container, root } = mount(createElement(TrimmingTool));
		const input = container.querySelector("input[type=file]");
		if (!input) throw new Error("Trimmer picker missing");
		Object.defineProperty(input, "files", {
			configurable: true,
			value: [new File(["video"], "video.mp4", { type: "video/mp4" })],
		});
		act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
		act(() => vi.advanceTimersByTime(10));
		expect(container.querySelector("video")?.getAttribute("src")).toBe(
			"blob:first",
		);
		act(() => root.render(createElement(TrimmingTool)));
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();
		expect(dragListeners).toBe(1);
		const preview = container.querySelector("video");
		if (!preview) throw new Error("Trimmer preview missing");
		Object.defineProperty(preview, "duration", { value: 60 });
		act(() => preview.dispatchEvent(new Event("loadedmetadata")));
		const labels = Array.from(container.querySelectorAll("label"));
		expect(labels).toHaveLength(2);
		for (const label of labels) {
			expect(label.control?.id).toBe(label.htmlFor);
			expect(label.htmlFor).not.toBe("");
		}
		const chooseDifferent = Array.from(
			container.querySelectorAll("button"),
		).find((button) => button.textContent === "Choose Different Video");
		if (!chooseDifferent) throw new Error("Replacement control missing");
		act(() => chooseDifferent.click());
		expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:first");
		const replacement = container.querySelector("input[type=file]");
		if (!replacement) throw new Error("Replacement picker missing");
		Object.defineProperty(replacement, "files", {
			value: [new File(["video"], "second.mp4", { type: "video/mp4" })],
		});
		act(() =>
			replacement.dispatchEvent(new Event("change", { bubbles: true })),
		);
		act(() => vi.advanceTimersByTime(10));
		expect(container.querySelector("video")?.getAttribute("src")).toBe(
			"blob:second",
		);
		act(() => root.unmount());
		roots.splice(roots.indexOf(root), 1);
		expect(vi.mocked(URL.revokeObjectURL).mock.calls).toEqual([
			["blob:first"],
			["blob:second"],
		]);
	});

	it("keeps JSON-LD parseable, closing-tag safe, and deduplicated by its existing identity", () => {
		const faq = dailyStandupSoftwareContent.faqs[0];
		if (!faq) throw new Error("FAQ fixture missing");
		const original = faq.question;
		const hostile = '</script><img src=x onerror="alert(1)"> & "quotes"';
		try {
			faq.question = hostile;
			handleClientScriptLoad(
				DailyStandupSoftwarePage().props.children[0].props,
			);
			const script = document.getElementById(
				"solutions-daily-standup-software-faq-structured-data",
			);
			expect(script?.getAttribute("type")).toBe("application/ld+json");
			expect(script?.textContent).not.toContain("</script>");
			expect(JSON.parse(script?.textContent ?? "").mainEntity[0].name).toBe(
				hostile,
			);
			handleClientScriptLoad(
				DailyStandupSoftwarePage().props.children[0].props,
			);
			expect(
				document.querySelectorAll(
					'[id="solutions-daily-standup-software-faq-structured-data"]',
				),
			).toHaveLength(1);
		} finally {
			faq.question = original;
		}
	});

	it("renders local tool rich text without executing supplied HTML", () => {
		const content = {
			title: "Tool",
			description: "Description",
			featuresTitle: "Features",
			featuresDescription:
				'<a href="/download">Download</a><img src=x onerror="alert(1)"><script>alert(2)</script>',
			features: [{ title: "Private", description: "Local" }],
			faqs: [],
			cta: { title: "Try", description: "Try it", buttonText: "Download" },
		};
		const { container } = mount(
			createElement(ToolsPageTemplate, { content, toolComponent: null }),
		);
		expect(container.querySelector('a[href="/download"]')?.textContent).toBe(
			"Download",
		);
		expect(container.querySelector("img, script")).toBeNull();
	});

	it("gives each decorative hue its own paired filter and gradient", () => {
		const html = renderToStaticMarkup(
			createElement(
				"div",
				null,
				createElement(LeftBlueHue),
				createElement(LeftBlueHue),
			),
		);
		const container = document.createElement("div");
		container.innerHTML = html;
		const ids = Array.from(
			container.querySelectorAll("[id]"),
			(node) => node.id,
		);
		expect(new Set(ids).size).toBe(ids.length);
		for (const svg of container.querySelectorAll("svg")) {
			expect(svg.getAttribute("aria-hidden")).toBe("true");
			for (const element of svg.querySelectorAll("[filter], [fill]")) {
				const ref = (
					element.getAttribute("filter") ?? element.getAttribute("fill")
				)?.match(/^url\(#(.+)\)$/)?.[1];
				if (ref)
					expect(
						Array.from(svg.querySelectorAll("[id]"), (node) => node.id),
					).toContain(ref);
			}
		}
	});

	it("renders the file picker as a named non-submitting control and respects disabled", () => {
		const { container, root } = mount(createElement(FileInput));
		const button = container.querySelector("button");
		expect(button?.textContent).toBe("Choose a file or drag & drop it here");
		expect(button?.type).toBe("button");
		const input = container.querySelector("input");
		if (!input || !button) throw new Error("File picker controls missing");
		const click = vi.spyOn(input, "click");
		act(() => button.click());
		expect(click).toHaveBeenCalledOnce();
		act(() => root.render(createElement(FileInput, { disabled: true })));
		act(() => button.click());
		expect(click).toHaveBeenCalledOnce();
	});

	it("cancels the success close timer on close and unmount, and restarts when reopened", () => {
		vi.useFakeTimers();
		const onClose = vi.fn();
		const props = {
			open: true,
			onClose,
			isVerified: true,
			setIsVerified: vi.fn(),
			setShowUpgradeModal: vi.fn(),
		};
		const { root } = mount(createElement(CustomDomainDialog, props));
		expect(vi.getTimerCount()).toBe(1);
		act(() =>
			root.render(createElement(CustomDomainDialog, { ...props, open: false })),
		);
		act(() => vi.advanceTimersByTime(8000));
		expect(onClose).not.toHaveBeenCalled();
		act(() => root.render(createElement(CustomDomainDialog, props)));
		act(() => vi.advanceTimersByTime(8000));
		expect(onClose).toHaveBeenCalledOnce();
	});
});

// @vitest-environment jsdom

import { act, type ComponentProps, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { Share } from "@/app/s/[videoId]/Share";
import type { ClientRevisionPlayback } from "@/lib/revision-playback";
import { shareCanDownload } from "@/lib/revision-playback";

vi.mock("motion/react", async () => {
	const { createElement } = await import("react");
	type MotionProps = Record<string, unknown> & { children?: ReactNode };
	const strip = (props: MotionProps) => {
		const {
			layout: _layout,
			layoutId: _layoutId,
			initial: _initial,
			animate: _animate,
			exit: _exit,
			transition: _transition,
			onLayoutAnimationStart: _onLayoutAnimationStart,
			onLayoutAnimationComplete: _onLayoutAnimationComplete,
			children,
			...rest
		} = props;
		return { children, rest };
	};
	const host =
		(tag: string) =>
		(props: MotionProps): ReactNode => {
			const { children, rest } = strip(props);
			return createElement(tag, rest, children);
		};
	return {
		AnimatePresence: ({ children }: { children?: ReactNode }) => children,
		useReducedMotion: () => false,
		motion: { div: host("div"), span: host("span") },
	};
});

vi.mock("next/dynamic", async () => {
	const { createElement } = await import("react");
	return {
		default: () => () => createElement("div"),
	};
});

vi.mock("next/image", async () => {
	const { createElement } = await import("react");
	return {
		default: ({ alt }: { alt?: string }) => createElement("img", { alt }),
	};
});

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(),
	useRouter: () => ({ refresh: () => undefined }),
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ initialData }: { initialData?: Record<string, unknown> }) => ({
		data: initialData,
	}),
}));

vi.mock("@/actions/videos/get-status", () => ({
	getVideoStatus: async () => ({}),
}));

vi.mock("@/app/s/[videoId]/_components/CaptionContext", () => ({
	CaptionProvider: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@/app/s/[videoId]/_components/ShareVideo", async () => {
	const { createElement } = await import("react");
	return {
		ShareVideo: () => createElement("video", { "data-share-video": "" }),
	};
});

vi.mock("@/app/s/[videoId]/_components/Sidebar", async () => {
	const { createElement } = await import("react");
	return {
		Sidebar: () => createElement("div", { "data-sidebar": "" }),
	};
});

vi.mock("@/app/s/[videoId]/_components/Toolbar", async () => {
	const { createElement } = await import("react");
	return { Toolbar: () => createElement("div") };
});

vi.mock("@/app/s/[videoId]/_components/SummaryChapters", async () => {
	const { createElement } = await import("react");
	return { default: () => createElement("div") };
});

const actEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type ShareComponentProps = ComponentProps<typeof Share>;

const revisionPlayback: ClientRevisionPlayback = {
	mode: "hls",
	videoId: "video-id",
	revisionId: "rev-new",
	generation: 2,
	playlistUrl: "/media/video-id/r/rev-new/playlist.m3u8?t=grant",
	duration: 12,
	captionsUrl: null,
	chapters: [],
	commentTimestamps: {},
	thumbnailUrl: null,
	downloadReady: false,
};

const createProps = (viewerId: string | null): ShareComponentProps =>
	({
		data: {
			id: "video-id",
			name: "Test video",
			orgId: "org-id",
			owner: { id: "owner-id", isPro: true },
			duration: 60,
			metadata: null,
			createdAt: new Date(),
			isScreenshot: false,
			transcriptionStatus: "COMPLETE",
			source: { type: "desktopMP4" },
			orgSettings: null,
		},
		comments: [],
		views: 0,
		customDomain: null,
		domainVerified: false,
		viewerId,
		viewerSignedIn: viewerId !== null,
		isEditProcessing: false,
		aiGenerationAvailable: false,
		transcriptionGenerationAvailable: false,
		revisionPlayback,
		header: createElement("header", { "data-share-header": "" }, "Title"),
	}) as unknown as ShareComponentProps;

async function renderShare(viewerId: string | null) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(createElement(Share, createProps(viewerId)));
	});
	return { container, root };
}

describe("revision download is not a header status", () => {
	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	afterAll(() => {
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	it.each([
		["owner", "owner-id"],
		["viewer", null],
	])("renders no Preparing label for a %s", async (_label, viewerId) => {
		const { container, root } = await renderShare(viewerId);
		expect(
			container.querySelector("[data-testid='revision-download-preparing']"),
		).toBeNull();
		expect(container.textContent).not.toContain("Preparing");
		await act(async () => {
			root.unmount();
		});
	});

	it("shows the download menu on an HLS revision before the MP4 is ready", () => {
		expect(
			shareCanDownload({
				playback: revisionPlayback,
				permitted: true,
			}),
		).toBe(true);
		expect(
			shareCanDownload({
				playback: { mode: "unavailable" },
				permitted: true,
			}),
		).toBe(false);
		expect(
			shareCanDownload({
				playback: null,
				permitted: true,
			}),
		).toBe(true);
		expect(
			shareCanDownload({
				playback: revisionPlayback,
				permitted: false,
			}),
		).toBe(false);
	});
});

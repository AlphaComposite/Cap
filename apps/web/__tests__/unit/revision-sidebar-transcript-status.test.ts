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

const seen = vi.hoisted(() => ({
	sidebarStatus: undefined as string | null | undefined,
	playerStatus: undefined as string | null | undefined,
	editProcessing: undefined as boolean | undefined,
}));

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
		ShareVideo: ({
			data,
			isEditProcessing,
		}: {
			data?: { transcriptionStatus?: string | null };
			isEditProcessing?: boolean;
		}) => {
			seen.playerStatus = data?.transcriptionStatus ?? null;
			seen.editProcessing = isEditProcessing;
			return createElement("video", { "data-share-video": "" });
		},
	};
});

vi.mock("@/app/s/[videoId]/_components/Sidebar", async () => {
	const { createElement } = await import("react");
	return {
		Sidebar: ({ data }: { data?: { transcriptionStatus?: string | null } }) => {
			seen.sidebarStatus = data?.transcriptionStatus ?? null;
			return createElement("div", { "data-sidebar": "" });
		},
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
	captionsUrl: "/media/video-id/r/rev-new/captions.vtt?t=grant",
	chapters: [{ title: "Cut", start: 0 }],
	commentTimestamps: {},
	thumbnailUrl: null,
	downloadReady: false,
};

const createProps = (): ShareComponentProps => ({
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
	} as unknown as ShareComponentProps["data"],
	comments: [],
	views: 0,
	customDomain: null,
	domainVerified: false,
	viewerId: "owner-id",
	isEditProcessing: true,
	aiGenerationAvailable: false,
	transcriptionGenerationAvailable: false,
	revisionPlayback,
});

describe("revision sidebar transcript status", () => {
	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		seen.sidebarStatus = undefined;
		seen.playerStatus = undefined;
		seen.editProcessing = undefined;
		document.body.replaceChildren();
		window.sessionStorage.removeItem("cap:instant-finish-playback");
	});

	afterAll(() => {
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	it("keeps COMPLETE on the sidebar when playback is a revision", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);

		await act(async () => {
			root.render(createElement(Share, createProps()));
		});

		expect(seen.sidebarStatus).toBe("COMPLETE");
		expect(seen.playerStatus).toBeNull();
		expect(seen.editProcessing).toBe(false);
		expect(seen.sidebarStatus !== "PROCESSING").toBe(true);

		await act(async () => {
			root.unmount();
		});
	});
});

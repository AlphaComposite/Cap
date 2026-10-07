// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveEditReadiness } from "../../lib/video-edit-readiness";

const mocks = vi.hoisted(() => ({ readiness: vi.fn(), owner: true }));
vi.mock("../../hooks/use-edit-readiness", () => ({
	useEditReadiness: mocks.readiness,
}));
vi.mock("@cap/env", () => ({ buildEnv: {}, NODE_ENV: "development" }));
vi.mock("@cap/utils", () => ({
	getProgressCircleConfig: () => ({ circumference: 50 }),
	calculateStrokeDashoffset: () => 0,
}));
vi.mock("@cap/ui", async () => {
	const { createElement } = await import("react");
	const wrapper = ({ children }: { children?: ReactNode }) =>
		createElement("div", null, children);
	return Object.fromEntries(
		[
			"Button",
			"DropdownMenu",
			"DropdownMenuContent",
			"DropdownMenuItem",
			"DropdownMenuSeparator",
			"DropdownMenuTrigger",
			"Logo",
		].map((name) => [name, wrapper]),
	);
});
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("next/link", async () => {
	const React = await import("react");
	return {
		default: ({ children }: { children?: ReactNode }) =>
			React.createElement("span", null, children),
	};
});
vi.mock("@tanstack/react-query", () => ({
	skipToken: Symbol(),
	useQuery: () => ({}),
	useQueryClient: () => ({}),
	useMutation: () => ({}),
}));
vi.mock("@/actions/organization/shareable-link-icon", () => ({
	hideShareableLinkCapLogo: vi.fn(),
	selectShareableLinkBrandingOrganization: vi.fn(),
}));
vi.mock("@/actions/videos/edit-title", () => ({ editTitle: vi.fn() }));
vi.mock("@/actions/video/retry-processing", () => ({
	retryVideoProcessing: vi.fn(),
}));
vi.mock("@/app/(org)/dashboard/DashboardContext", () => ({
	useDashboardContext: () => ({}),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		user: { isPro: true },
		activeOrganization: null,
	}),
}));
vi.mock("@/app/Layout/AuthContext", () => ({
	useCurrentUser: () => ({ id: mocks.owner ? "owner" : "other" }),
}));
vi.mock("@/utils/public-env", () => ({ usePublicEnv: () => ({ webUrl: "" }) }));
vi.mock("@/lib/video-share-clipboard", () => ({
	copyRichVideoLink: vi.fn(),
	videoPreviewImageUrl: vi.fn(),
}));
vi.mock("@/components/Tooltip", () => ({
	Tooltip: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/components/SignedImageUrl", () => ({ SignedImageUrl: () => null }));
vi.mock("@/app/s/[videoId]/_components/use-video-download", () => ({
	useVideoDownload: () => ({}),
}));
vi.mock("@/app/s/[videoId]/_components/VideoDownloadMenu", () => ({
	VideoDownloadMenu: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/ProgressCircle", () => ({
	useUploadProgress: () => null,
}));
vi.mock("@/lib/EffectRuntime", () => ({
	useEffectMutation: () => ({}),
	useRpcClient: () => ({}),
}));
vi.mock("@/lib/Requests/ThumbnailRequest", () => ({
	ThumbnailRequest: { queryKey: vi.fn() },
}));
vi.mock("@/components/UpgradeModal", () => ({ UpgradeModal: () => null }));
vi.mock("@/components/VideoThumbnail", () => ({ VideoThumbnail: () => null }));
vi.mock("@/app/(org)/dashboard/_components/ConfirmationDialog", () => ({
	ConfirmationDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/MoveItemsDialog", () => ({
	MoveItemsDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/PasswordDialog", () => ({
	PasswordDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/SettingsDialog", () => ({
	SettingsDialog: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/SharingDialog", () => ({
	SharingDialog: () => null,
}));
vi.mock(
	"@/app/(org)/dashboard/caps/components/CapCard/CapCardAnalytics",
	() => ({ CapCardAnalytics: () => null }),
);
vi.mock("@/app/(org)/dashboard/caps/components/CapCard/CapCardContent", () => ({
	CapCardContent: () => null,
}));
vi.mock("@/app/(org)/dashboard/caps/components/CapCard/CapCardButton", () => ({
	CapCardButton: () => null,
}));

import { CapCard } from "../../app/(org)/dashboard/caps/components/CapCard/CapCard";
import { ShareHeader } from "../../app/s/[videoId]/_components/ShareHeader";

const data = {
	id: "video",
	ownerId: "owner",
	owner: { id: "owner", isPro: true },
	name: "Synthetic",
	source: { type: "webMP4" },
	duration: 20,
	createdAt: new Date(0),
	totalComments: 0,
	totalReactions: 0,
	public: true,
};
const state = (status: string | null = "PROCESSING", admitted = true) => ({
	readiness: deriveEditReadiness({
		videoId: "video",
		identity: "current",
		eligible: true,
		isPro: true,
		playbackAdmission: admitted,
		videoState: "processed",
		transcriptionStatus: status,
		transcriptRead: status === "COMPLETE" ? "ready" : "unavailable",
	}),
	message: "",
	checking: false,
	checkAgain: vi.fn(),
});
beforeEach(() => {
	mocks.owner = true;
	mocks.readiness.mockReturnValue(state());
});
const card = () =>
	renderToStaticMarkup(
		createElement(CapCard, {
			cap: data,
			userId: mocks.owner ? "owner" : "other",
		} as never),
	);
const header = () =>
	renderToStaticMarkup(createElement(ShareHeader, { data } as never));
describe("owner entrypoint presentation", () => {
	it("renders separate video/transcript labels on the dashboard card", () => {
		expect(card()).toContain("Video processed · Transcribing");
		expect(card()).toContain("Edit timeline");
	});
	it("renders one processing panel and Edit video for desktop and mobile header entries", () => {
		const html = header();
		expect(html.match(/aria-label="Video processing"/g)).toHaveLength(1);
		expect(html).toContain("Preparing for editing");
		expect(html.match(/Edit video/g)).toHaveLength(2);
	});
	it.each(["ERROR", "SKIPPED", "NO_AUDIO", null])(
		"keeps manual entrypoints for %s",
		(status) => {
			mocks.readiness.mockReturnValue(state(status));
			expect(card()).toContain("Edit timeline");
			expect(header()).toContain("Edit video");
		},
	);
	it("does not expose owner readiness for nonowners", () => {
		mocks.owner = false;
		expect(card()).not.toContain("Transcribing");
		expect(header()).not.toContain("Transcribing");
	});
	it("does not advertise editing without admission", () => {
		mocks.readiness.mockReturnValue(state("PROCESSING", false));
		expect(card()).not.toContain("Edit timeline");
		expect(header()).not.toContain("Edit timeline");
		expect(header()).not.toContain("Edit video");
	});
});

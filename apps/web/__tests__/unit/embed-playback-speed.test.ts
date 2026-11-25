import { Context, Effect } from "effect";
import {
	Children,
	isValidElement,
	type ReactElement,
	type ReactNode,
} from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	select: vi.fn(),
	canView: vi.fn(),
	loadRevisionPlayback: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: () => ({ select: mocks.select }) }));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => null,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
}));
vi.mock("@cap/ui", () => ({ Logo: () => null }));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("@cap/web-backend", () => ({
	ImageUploads: Context.GenericTag("EmbedTestImages"),
	VideosPolicy: Context.GenericTag("EmbedTestPolicy"),
	provideOptionalAuth: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
	resolveEffectiveVideoRules: () => ({ settings: {} }),
}));
vi.mock("@/lib/server", () => ({
	runPromise: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
		effect.pipe(
			Effect.provideService(Context.GenericTag("EmbedTestImages"), {
				resolveImageUrl: (url: string) => url,
			}),
			Effect.provideService(Context.GenericTag("EmbedTestPolicy"), {
				canView: () => mocks.canView() ?? Effect.void,
			}),
			Effect.runPromise,
		),
}));
vi.mock("@/lib/shareable-link-quota", () => ({
	isVideoOverShareableLinkLimit: async () => false,
}));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));
vi.mock("@/lib/revision-playback-load", () => ({
	loadRevisionPlayback: async () =>
		mocks.loadRevisionPlayback() ?? { playback: null },
}));
vi.mock("@/utils/flags", () => ({ isAiGenerationEnabled: async () => false }));
vi.mock("@/app/embed/[videoId]/_components/PasswordOverlay", () => ({
	PasswordOverlay: () => null,
}));
vi.mock("@/app/embed/[videoId]/_components/EmbedVideo", () => ({
	EmbedVideo: () => null,
}));

import { EmbedVideo } from "@/app/embed/[videoId]/_components/EmbedVideo";
import EmbedVideoPage from "@/app/embed/[videoId]/page";

async function renderEmbed(
	videoSpeed: number | undefined,
	orgSpeed: number | undefined,
	minimal = false,
	searchParams: Record<string, string | string[] | undefined> = {},
) {
	const video = {
		id: "video",
		ownerId: "owner",
		settings:
			videoSpeed === undefined ? null : { defaultPlaybackSpeed: videoSpeed },
		orgSettings:
			orgSpeed === undefined ? null : { defaultPlaybackSpeed: orgSpeed },
		transcriptionStatus: "COMPLETE",
		source: { type: "desktopMP4" },
	};
	mocks.select.mockImplementation((selection: Record<string, unknown>) => {
		const rows =
			"ownerId" in selection
				? [video]
				: "email" in selection
					? [{ email: "owner@example.com" }]
					: [];
		const query = {
			from: () => query,
			leftJoin: () => query,
			innerJoin: () => query,
			where: () => Object.assign(Promise.resolve(rows), { limit: () => rows }),
		};
		return query;
	});

	const page = (await EmbedVideoPage({
		params: Promise.resolve({ videoId: "video" }),
		searchParams: Promise.resolve({
			...searchParams,
			...(minimal ? { slack: "true" } : {}),
		}),
	})) as ReactElement<{ children: unknown[] }>;
	const content = page.props.children[1];
	if (!isValidElement(content) || typeof content.type !== "function") {
		throw new Error("Expected authorized embed content");
	}
	const fragment = (await (
		content.type as (props: unknown) => Promise<unknown>
	)(content.props)) as ReactElement<{ children: ReactElement[] }>;
	const embed = Children.toArray(fragment.props.children).find(
		(child) => isValidElement(child) && child.type === EmbedVideo,
	);
	if (!isValidElement(embed)) throw new Error("Expected embed player");
	return embed as ReactElement<{
		defaultPlaybackSpeed?: number;
		minimal: boolean;
		showTitle: boolean;
		showOwner: boolean;
		startTime: number | null;
		autoplay: boolean;
		revisionPlayback: unknown;
	}>;
}

describe("embed display params", () => {
	it.each(["PolicyDenied", "VerifyVideoPasswordError"])(
		"does not bypass %s with hidden title and owner",
		async (_tag) => {
			mocks.canView.mockReturnValueOnce(Effect.fail({ _tag }));
			const page = (await EmbedVideoPage({
				params: Promise.resolve({ videoId: "video" }),
				searchParams: Promise.resolve({ title: "false", owner: "false" }),
			})) as ReactElement<{ children: ReactNode[] }>;
			if (_tag === "PolicyDenied") {
				expect(
					Children.toArray(page.props.children).some(
						(child) =>
							isValidElement<{ children: ReactNode }>(child) &&
							child.type === "h1" &&
							child.props.children === "This video is private",
					),
				).toBe(true);
			} else {
				const overlay = page.props.children[0] as ReactElement<{
					isOpen: boolean;
				}>;
				expect(overlay.props.isOpen).toBe(true);
				expect(page.props.children[1]).toBe(false);
			}
			expect(mocks.loadRevisionPlayback).not.toHaveBeenCalled();
		},
	);

	it("passes the same granted revision playback through with title and owner hidden", async () => {
		const playback = {
			mode: "hls",
			videoId: "video",
			revisionId: "synthetic-revision",
			duration: 120,
			playlistUrl:
				"https://cap.so/media/video/r/synthetic-revision/playlist.m3u8?t=synthetic-grant",
		};
		mocks.loadRevisionPlayback.mockReturnValueOnce({ playback });
		const embed = await renderEmbed(undefined, undefined, false, {
			title: "false",
			owner: "false",
		});
		expect(embed.props.revisionPlayback).toBe(playback);
		expect(embed.props.showTitle).toBe(false);
		expect(embed.props.showOwner).toBe(false);
	});
	it.each([
		undefined,
		"",
		"true",
		"0",
		"FALSE",
		" false",
		"no",
		["false"],
		["false", "true"],
	])("keeps display defaults for %j", async (value) => {
		const embed = await renderEmbed(undefined, undefined, false, {
			title: value,
			owner: value,
		});
		expect(embed.props.showTitle).toBe(true);
		expect(embed.props.showOwner).toBe(true);
	});

	it.each(["title", "owner"])(
		"only hides %s on scalar false, preserving timestamp and autoplay",
		async (key) => {
			const embed = await renderEmbed(undefined, undefined, false, {
				[key]: "false",
				t: ["83", "12"],
				autoplay: "true",
			});
			expect(embed.props.showTitle).toBe(key !== "title");
			expect(embed.props.showOwner).toBe(key !== "owner");
			expect(embed.props.startTime).toBe(83);
			expect(embed.props.autoplay).toBe(true);
		},
	);
});

describe("embed default playback speed", () => {
	it.each([
		{ name: "organization 1×", video: undefined, org: 1, expected: 1 },
		{ name: "video override", video: 1.5, org: 1, expected: 1.5 },
		{ name: "video 1× override", video: 1, org: 1.5, expected: 1 },
		{ name: "no settings", video: undefined, org: undefined, expected: 1.2 },
		{ name: "invalid video speed", video: 0, org: 1, expected: 1 },
		{ name: "invalid speeds", video: -1, org: 0, expected: 1.2 },
		{ name: "legacy speed normalization", video: 1.3, org: 1, expected: 1.2 },
	])("resolves $name", async ({ video, org, expected }) => {
		const embed = await renderEmbed(video, org);
		expect(embed.props.defaultPlaybackSpeed).toBe(expected);
	});

	it("uses the organization speed for minimal embeds", async () => {
		const embed = await renderEmbed(undefined, 1, true);
		expect(embed.props.minimal).toBe(true);
		expect(embed.props.defaultPlaybackSpeed).toBe(1);
	});
});

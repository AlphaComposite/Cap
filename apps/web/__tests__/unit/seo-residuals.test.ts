// @vitest-environment jsdom

import {
	handleClientScriptLoad,
	type ScriptProps,
} from "next/dist/client/script";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgenciesRoute from "../../app/(site)/(seo)/solutions/agencies/page";
import { RecordScreenMacStructuredData } from "../../components/blog/RecordScreenMacStructuredData";
import { DailyStandupSoftwarePage } from "../../components/pages/seo/DailyStandupSoftwarePage";
import { EmployeeOnboardingPlatformPage } from "../../components/pages/seo/EmployeeOnboardingPlatformPage";
import { LoomAlternativePage } from "../../components/pages/seo/LoomAlternativePage";
import { OnlineClassroomToolsPage } from "../../components/pages/seo/OnlineClassroomToolsPage";
import { RemoteTeamCollaborationPage } from "../../components/pages/seo/RemoteTeamCollaborationPage";
import { ScreenRecordingSoftwarePage } from "../../components/pages/seo/ScreenRecordingSoftwarePage";
import { ScreenRecordMacPage } from "../../components/pages/seo/ScreenRecordMacPage";
import { ScreenRecordWindowsPage } from "../../components/pages/seo/ScreenRecordWindowsPage";
import { recordScreenMacContent } from "../../content/blog-content/record-screen-mac-system-audio";

vi.mock("@/components/seo/SeoPageTemplate", () => ({
	SeoPageTemplate: () => null,
}));
vi.mock("@/components/pages/seo/AgenciesPage", () => ({
	AgenciesPage: () => null,
}));
vi.mock("@/lib/og/url", () => ({ ogImageUrl: () => "/og-fixture" }));

afterEach(() => {
	const { currentTestName, assertionCalls } = expect.getState();
	console.info(
		"SEO_ASSERTIONS",
		JSON.stringify({ currentTestName, assertionCalls }),
	);
});

const routes = [
	[AgenciesRoute, "solutions-agencies", ["faq", "software"]],
	[
		RecordScreenMacStructuredData,
		"blog-record-screen-mac-system-audio",
		["article", "faq"],
	],
	[
		EmployeeOnboardingPlatformPage,
		"solutions-employee-onboarding-platform",
		["faq"],
	],
	[OnlineClassroomToolsPage, "solutions-online-classroom-tools", ["faq"]],
	[ScreenRecordMacPage, "screen-recorder-mac", ["faq"]],
	[DailyStandupSoftwarePage, "solutions-daily-standup-software", ["faq"]],
	[LoomAlternativePage, "loom-alternative", ["faq"]],
	[RemoteTeamCollaborationPage, "solutions-remote-team-collaboration", ["faq"]],
	[ScreenRecordWindowsPage, "screen-recorder-windows", ["faq", "software-app"]],
	[ScreenRecordingSoftwarePage, "screen-recording-software", ["faq"]],
] as const;

function scriptsFor(component: (typeof routes)[number][0]) {
	return Children.toArray(component().props.children).filter(
		(child): child is React.ReactElement<ScriptProps> =>
			isValidElement<ScriptProps>(child) &&
			child.props.type === "application/ld+json",
	);
}

describe("scoped SEO residual repairs", () => {
	it("namespaces every script by canonical route and schema kind with stable repeat identities", () => {
		const ids: string[] = [];
		for (const [component, route, kinds] of routes) {
			const scripts = scriptsFor(component);
			expect(scripts.map(({ props }) => props.id)).toEqual(
				kinds.map((kind) => `${route}-${kind}-structured-data`),
			);
			expect(scriptsFor(component).map(({ props }) => props)).toEqual(
				scripts.map(({ props }) => props),
			);
			for (const { props } of scripts) {
				expect(props.type).toBe("application/ld+json");
				expect(props.strategy).toBeUndefined();
				if (!props.id) throw new Error("Missing script ID");
				ids.push(props.id);
			}
		}
		expect(ids).toHaveLength(13);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("loads route B's distinct payload after A and deduplicates repeated A using installed Next", () => {
		const [a] = scriptsFor(DailyStandupSoftwarePage);
		const [b] = scriptsFor(LoomAlternativePage);
		if (!a || !b) throw new Error("Missing FAQ scripts");
		expect(a.props.children).not.toBe(b.props.children);
		handleClientScriptLoad(a.props);
		handleClientScriptLoad(b.props);
		const loaded = [...document.querySelectorAll("script[data-nscript]")];
		expect(loaded.map((node) => node.textContent)).toEqual([
			a.props.children,
			b.props.children,
		]);
		expect(a.props.id).not.toBe(b.props.id);
		const [repeatA] = scriptsFor(DailyStandupSoftwarePage);
		if (!repeatA) throw new Error("Missing repeated FAQ script");
		handleClientScriptLoad(repeatA.props);
		expect(document.querySelectorAll("script[data-nscript]")).toHaveLength(2);
		expect(document.getElementById(a.props.id ?? "")).toBe(loaded[0]);
		expect(document.getElementById(b.props.id ?? "")).toBe(loaded[1]);
	});

	it("preserves hostile closing tags as JSON values without creating injected markup", () => {
		const original = recordScreenMacContent.title;
		const faq = recordScreenMacContent.faqs[0];
		if (!faq) throw new Error("Missing blog FAQ");
		const originalQuestion = faq.question;
		const hostile =
			'</ScRiPt><img src=x onerror="alert(1)"> & "quotes" \u2028\u2029';
		try {
			recordScreenMacContent.title = hostile;
			faq.question = hostile;
			const [article, faqScript] = scriptsFor(RecordScreenMacStructuredData);
			if (!article || !faqScript) throw new Error("Missing blog scripts");
			const faqText = String(faqScript.props.children);
			expect(JSON.parse(faqText).mainEntity[0].name).toBe(hostile);
			expect(faqText).not.toContain("<");
			handleClientScriptLoad(faqScript.props);
			expect(
				JSON.parse(
					document.getElementById(faqScript.props.id ?? "")?.textContent ?? "",
				).mainEntity[0].name,
			).toBe(hostile);
			const text = String(article.props.children);
			expect(JSON.parse(text).headline).toBe(hostile);
			expect(text).not.toContain("<");
			expect(text).not.toContain("&");
			expect(text).not.toContain("\u2028");
			expect(text).not.toContain("\u2029");
			handleClientScriptLoad(article.props);
			expect(
				JSON.parse(
					document.getElementById(article.props.id ?? "")?.textContent ?? "",
				).headline,
			).toBe(hostile);
			const host = document.createElement("div");
			host.innerHTML = renderToStaticMarkup(
				createElement("script", { type: article.props.type }, text),
			);
			expect(host.querySelectorAll("script")).toHaveLength(1);
			expect(host.querySelector("img")).toBeNull();
			expect(
				JSON.parse(host.querySelector("script")?.textContent ?? "").headline,
			).toBe(hostile);
		} finally {
			recordScreenMacContent.title = original;
			faq.question = originalQuestion;
		}
	});
});

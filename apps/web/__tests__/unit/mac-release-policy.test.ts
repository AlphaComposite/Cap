import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { getLatestRelease, getReleases, detected } = vi.hoisted(() => ({
	getLatestRelease: vi.fn(),
	getReleases: vi.fn(),
	detected: { platform: "macos", isIntel: false },
}));

vi.mock("@octokit/rest", () => ({
	Octokit: class {
		repos = { getLatestRelease };
	},
}));
vi.mock("hooks/useDetectPlatform", () => ({
	useDetectPlatform: () => detected,
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock(
	"@cap/ui",
	() => import("../../../../packages/ui/src/components/Button"),
);
vi.mock("@/lib/og/url", () => ({ buildMarketingMetadata: () => ({}) }));
vi.mock("@/utils/releases", async (original) => ({
	...(await original<typeof import("@/utils/releases")>()),
	getGitHubReleases: getReleases,
}));

import VersionsPage from "@/app/(site)/download/versions/page";
import { GET as update } from "@/app/api/releases/tauri/[version]/[target]/[arch]/route";
import { GET as installer } from "@/app/install-cli.sh/route";
import { DownloadPage } from "@/components/pages/DownloadPage";
import { getDownloadUrl } from "@/utils/platform";
import { lastIntelMacRelease, parseDownloadsFromBody } from "@/utils/releases";

const request = new Request("https://example.test/update");
const context = (arch: string) => ({
	params: Promise.resolve({ version: "0.6.0", target: "darwin", arch }),
});

describe("Apple Silicon future release policy", () => {
	it("never queries the update provider for Intel Macs", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		try {
			expect((await update(request, context("x86_64"))).status).toBe(204);
			expect(getLatestRelease).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("selects the ARM update and its own signature, never the first Intel asset", async () => {
		getLatestRelease.mockResolvedValue({
			data: {
				tag_name: "cap-v0.6.3",
				assets: [
					"Cap_x64.app.tar.gz",
					"Cap_x64.app.tar.gz.sig",
					"Cap_aarch64.app.tar.gz",
					"Cap_aarch64.app.tar.gz.sig",
				].map((name) => ({
					name,
					browser_download_url: `https://example.test/${name}`,
				})),
			},
		});
		const fetch = vi.fn().mockResolvedValue(new Response("arm-signature"));
		vi.stubGlobal("fetch", fetch);
		try {
			const response = await update(request, context("aarch64"));
			expect(await response.json()).toMatchObject({
				url: "https://example.test/Cap_aarch64.app.tar.gz",
				signature: "arm-signature",
			});
			expect(fetch).toHaveBeenCalledWith(
				"https://example.test/Cap_aarch64.app.tar.gz.sig",
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps Windows and Linux x86 downloads while separating unsupported Intel history", () => {
		expect(getDownloadUrl("windows", true)).toBe("/download/windows");
		expect(getDownloadUrl("linux", true)).toBe("/download/linux-deb");
		expect(getDownloadUrl("macos", false)).toBe("/download/apple-silicon");
		expect(getDownloadUrl("macos", true)).toBe("/download/versions#intel-mac");
		const html = renderToStaticMarkup(createElement(DownloadPage));
		expect(html).toContain("Download for Apple Silicon");
		expect(html).toContain("macOS 14.0 or later");
		expect(html).toContain('href="/download/windows"');
		expect(html).toContain('href="/download/linux-deb"');
		expect(html).not.toContain('href="/download/apple-intel"');
		detected.isIntel = true;
		try {
			const intelHtml = renderToStaticMarkup(createElement(DownloadPage));
			expect(intelHtml).toContain('href="/download/versions#intel-mac"');
			expect(intelHtml).toContain("Intel Mac releases (unsupported)");
		} finally {
			detected.isIntel = false;
		}
	});

	it("rejects Intel in the actual shell installer before curl or filesystem commands", async () => {
		const script = await (await installer()).text();
		const macInstaller = script.match(
			/install_cap_desktop_macos\(\) \{[\s\S]*?\n\}/,
		)?.[0];
		expect(macInstaller).toBeDefined();
		const result = spawnSync(
			"sh",
			[
				"-c",
				`uname() { printf x86_64; }; curl() { printf unexpected-download; }; mktemp() { printf unexpected-filesystem; }; ${macInstaller}\ninstall_cap_desktop_macos`,
			],
			{ encoding: "utf8", timeout: 5000 },
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"Future Mac releases require Apple Silicon",
		);
		expect(result.stdout).toBe("");
	});

	it("preserves explicit Intel version URLs as unsupported even on the newest history row", async () => {
		const downloads = parseDownloadsFromBody(
			'<!-- DOWNLOADS_JSON {"macos-x64":"https://example.test/0.6.2-intel.dmg"} -->',
		);
		getReleases.mockResolvedValue([
			{
				version: "0.6.2",
				tagName: "cap-v0.6.2",
				publishedAt: "2026-10-01T00:00:00Z",
				htmlUrl: "https://example.test/notes",
				downloads,
			},
		]);
		const html = renderToStaticMarkup(await VersionsPage());
		expect(html).toContain('href="https://example.test/0.6.2-intel.dmg"');
		expect(html).toContain("Intel (unsupported)");
		expect(html).toContain(lastIntelMacRelease.url);
		expect(lastIntelMacRelease.url).not.toContain("latest");
		expect(html).toContain("This fork has not published an Intel release");
	});

	it("only produces ARM Mac releases while preserving the Windows/Linux release targets and functional CI", () => {
		const workflow = readFileSync(
			new URL(
				"../../../../.github/workflows/desktop-release.yml",
				import.meta.url,
			),
			"utf8",
		);
		expect(workflow).not.toContain("target: x86_64-apple-darwin");
		for (const target of [
			"aarch64-apple-darwin",
			"x86_64-pc-windows-msvc",
			"x86_64-unknown-linux-gnu",
		])
			expect(workflow).toContain(`target: ${target}`);
		const ci = readFileSync(
			new URL("../../../../.github/workflows/ci.yml", import.meta.url),
			"utf8",
		);
		expect(ci).not.toContain("target: x86_64-apple-darwin");
		expect(ci).toContain("target: aarch64-apple-darwin");
		expect(ci).toContain("target: x86_64-pc-windows-msvc");
	});
});

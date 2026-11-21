import { describe, expect, it } from "vitest";
import {
	getDownloadButtonText,
	getDownloadUrl,
	getVersionText,
} from "@/utils/platform";

describe("download platform helpers", () => {
	it("routes Linux users to the Linux deb download", () => {
		expect(getDownloadUrl("linux", false)).toBe("/download/linux-deb");
		expect(getDownloadButtonText("linux", false)).toBe("Download for free");
		expect(getVersionText("linux")).toBe(
			"Linux x86_64 • .deb, AppImage, RPM and Arch available",
		);
	});

	it("keeps Apple Silicon and Windows routing while sending Intel to unsupported history", () => {
		expect(getDownloadUrl("macos", false)).toBe("/download/apple-silicon");
		expect(getDownloadUrl("macos", true)).toBe("/download/versions#intel-mac");
		expect(getDownloadUrl("windows", false)).toBe("/download/windows");
		expect(getVersionText("macos", false)).toContain("macOS 14.0");
		expect(getVersionText("macos", true)).toContain("original requirements");
		expect(getVersionText("macos", true)).not.toContain("14.0");
	});
});

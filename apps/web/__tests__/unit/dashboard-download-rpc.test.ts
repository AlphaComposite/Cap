import { readFileSync } from "node:fs";
import { Cause, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
	presentRpcDownload,
	readDashboardDownloadResult,
} from "@/lib/dashboard-download";
import {
	DOWNLOAD_PREPARING_MESSAGE,
	revisionDownloadOutcome,
} from "../../../../packages/web-backend/src/Videos/editedDownload";

const backendSource = readFileSync(
	new URL(
		"../../../../packages/web-backend/src/Videos/index.ts",
		import.meta.url,
	),
	"utf8",
);
const domainSource = readFileSync(
	new URL("../../../../packages/web-domain/src/Video.ts", import.meta.url),
	"utf8",
);

const downloadInfoSource = backendSource.slice(
	backendSource.indexOf("getDownloadInfo:"),
	backendSource.indexOf("getThumbnailURL:"),
);

const readyUrl = "https://origin.test/media/video/r/rev/download.mp4?t=grant";

describe("dashboard download RPC", () => {
	it("resolves an edited video through the revision download instead of a missing URL", () => {
		expect(downloadInfoSource).toContain("editedDownloadFromLookup");
		expect(downloadInfoSource).toContain("DownloadPreparingError");
		expect(downloadInfoSource).toContain("outcome.downloadUrl");
		expect(downloadInfoSource).not.toContain(
			"if (!eligible) return Option.none()",
		);
		expect(domainSource).toContain(`"${DOWNLOAD_PREPARING_MESSAGE}"`);
		expect(domainSource).toContain("DownloadPreparingError");
	});

	it("returns the revision URL when READY, a neutral message when PENDING, and leaves an unedited video on the legacy path", () => {
		expect(
			revisionDownloadOutcome({
				flagged: true,
				eligible: false,
				name: "Edited clip",
				downloadUrl: readyUrl,
			}),
		).toEqual({
			status: "ready",
			fileName: "Edited clip.mp4",
			downloadUrl: readyUrl,
		});

		expect(
			revisionDownloadOutcome({
				flagged: true,
				eligible: false,
				name: "Edited clip",
				downloadUrl: null,
			}),
		).toEqual({
			status: "preparing",
			message: "Preparing your download. Try again in a minute.",
		});

		expect(
			revisionDownloadOutcome({
				flagged: true,
				eligible: true,
				name: "Unedited clip",
				downloadUrl: readyUrl,
			}),
		).toEqual({ status: "legacy" });

		expect(
			revisionDownloadOutcome({
				flagged: false,
				eligible: false,
				name: "Unedited clip",
				downloadUrl: null,
			}),
		).toEqual({ status: "legacy" });
	});

	it("shows the revision file, a neutral notice, or the existing red error", () => {
		expect(
			presentRpcDownload({
				_tag: "Some",
				value: {
					fileName: "Edited clip.mp4",
					downloadUrl: readyUrl,
				},
			}),
		).toEqual({
			action: "save",
			fileName: "Edited clip.mp4",
			downloadUrl: readyUrl,
		});

		expect(
			presentRpcDownload({
				_tag: "DownloadPreparingError",
				message: DOWNLOAD_PREPARING_MESSAGE,
			}),
		).toEqual({
			action: "notice",
			message: "Preparing your download. Try again in a minute.",
		});

		expect(presentRpcDownload({ _tag: "None" })).toEqual({
			action: "error",
			message: "Failed to get download URL",
		});
	});

	it("keeps a preparing download off the red toast after mutateAsync wraps the result", () => {
		const preparing = {
			kind: "preparing" as const,
			message: DOWNLOAD_PREPARING_MESSAGE,
		};
		expect(readDashboardDownloadResult(Exit.succeed(preparing))).toEqual(
			preparing,
		);
		expect(
			readDashboardDownloadResult(
				Exit.fail(
					Cause.fail({
						_tag: "DownloadPreparingError",
						message: DOWNLOAD_PREPARING_MESSAGE,
					}),
				),
			),
		).toEqual(preparing);
		expect(
			readDashboardDownloadResult(Exit.succeed({ kind: "started" as const })),
		).toEqual({ kind: "started" });
		expect(() =>
			readDashboardDownloadResult(
				Exit.fail(Cause.fail(new Error("Failed to get download URL"))),
			),
		).toThrow("Failed to get download URL");
	});
});

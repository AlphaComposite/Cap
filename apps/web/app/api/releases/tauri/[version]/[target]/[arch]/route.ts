import { Octokit } from "@octokit/rest";

const octokit = new Octokit();

export const runtime = "edge";

export async function GET(
	_req: Request,
	props: RouteContext<"/api/releases/tauri/[version]/[target]/[arch]">,
) {
	const params = await props.params;
	if (
		params.target === "darwin" &&
		!["aarch64", "arm64"].includes(params.arch)
	) {
		return new Response(null, { status: 204 });
	}
	try {
		const { data: release } = await octokit.repos.getLatestRelease({
			owner: "capsoftware",
			repo: "cap",
		});

		const version = release.tag_name.replace("cap-v", "");
		const notes = release.body;
		const pub_date = release.published_at
			? new Date(release.published_at).toISOString()
			: null;

		const asset = release.assets.find((asset) => {
			const isTargetMatch =
				asset.name.endsWith(".tar.gz") && !asset.name.endsWith(".tar.gz.sig");

			return (
				isTargetMatch &&
				(params.target !== "darwin" || /(?:aarch64|arm64)/.test(asset.name))
			);
		});

		if (!asset) {
			return new Response(null, {
				status: 204,
			});
		}

		const url = asset.browser_download_url;

		const signatureAsset = release.assets.find(({ name }) =>
			params.target === "darwin"
				? name === `${asset.name}.sig`
				: name.endsWith(".sig"),
		);

		if (!signatureAsset) {
			return new Response(null, {
				status: 204,
			});
		}

		const signature = await fetch(signatureAsset.browser_download_url).then(
			(r) => r.text(),
		);

		return Response.json(
			{ version, notes, pub_date, url, signature },
			{ status: 200 },
		);
	} catch (error) {
		console.error("Error fetching latest release:", error);
		return Response.json({ error: "Missing required fields" }, { status: 400 });
	}
}

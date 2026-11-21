import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";

import * as path from "node:path";
import { test } from "node:test";
import * as setup from "./setup.js";

const {
	downloadVerifiedAsset,
	installFfmpegRoot,
	onnxRuntimeAsset,
	setupLinuxOnnxRuntime,
	setupMacOSOnnxRuntime,
	setupWindowsOnnxRuntime,
	stageOnnxRuntime,
} = setup;

async function temporaryDirectory(t) {
	const base = process.env.TMPDIR ?? path.resolve("target");
	await fs.mkdir(base, { recursive: true });
	const directory = await fs.mkdtemp(path.join(base, "cap-native-setup-"));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	return directory;
}

const zipBytes = Buffer.from("504b030466697874757265", "hex");
const asset = {
	name: "fixture.zip",
	url: "https://example.com/fixture.zip",
	sha256: createHash("sha256").update(zipBytes).digest("hex"),
};

async function ffmpegFixture(directory, rootName) {
	const root = path.join(directory, rootName);
	for (const file of [
		"bin/ffmpeg.exe",
		"bin/ffprobe.exe",
		"bin/avcodec-61.dll",
		"lib/avcodec.lib",
		"include/libavcodec/avcodec.h",
	]) {
		const destination = path.join(root, file);
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.writeFile(destination, "fixture");
	}
	return root;
}

test("macOS setup rejects HTTP errors before caching or extracting a response", async (t) => {
	const directory = await temporaryDirectory(t);
	t.mock.method(
		globalThis,
		"fetch",
		async () => new Response("Not Found", { status: 404 }),
	);
	await assert.rejects(setupMacOSOnnxRuntime(directory), /HTTP 404/);
	assert.deepEqual(await fs.readdir(directory), []);
});

test("the shared downloader never caches HTTP errors or incomplete bodies", async (t) => {
	const directory = await temporaryDirectory(t);
	const fetch = t.mock.method(
		globalThis,
		"fetch",
		async () => new Response(zipBytes, { status: 503 }),
	);
	await assert.rejects(downloadVerifiedAsset(asset, directory), /HTTP 503/);
	assert.deepEqual(await fs.readdir(directory), []);
	fetch.mock.mockImplementation(async () => ({
		ok: true,
		arrayBuffer: async () => {
			throw new Error("interrupted body");
		},
	}));
	await assert.rejects(
		downloadVerifiedAsset(asset, directory),
		/interrupted body/,
	);
	assert.deepEqual(await fs.readdir(directory), []);
});

test("verified downloads reuse good caches and remove checksum mismatches", async (t) => {
	const directory = await temporaryDirectory(t);
	const fetch = t.mock.method(
		globalThis,
		"fetch",
		async () => new Response(zipBytes),
	);
	const archive = await downloadVerifiedAsset(asset, directory);
	assert.deepEqual(await fs.readFile(archive), zipBytes);
	assert.equal(await downloadVerifiedAsset(asset, directory), archive);
	assert.equal(fetch.mock.callCount(), 1);
	await fs.writeFile(archive, "corrupt cache");
	await assert.rejects(
		downloadVerifiedAsset(asset, directory),
		/SHA-256 mismatch/,
	);
	assert.deepEqual(await fs.readdir(directory), []);
	fetch.mock.mockImplementation(async () => new Response("corrupt response"));
	await assert.rejects(
		downloadVerifiedAsset(asset, directory),
		/SHA-256 mismatch/,
	);
	assert.deepEqual(await fs.readdir(directory), []);
});

test("cached HTTP error pages are removed even without a published checksum", async (t) => {
	const directory = await temporaryDirectory(t);
	await fs.writeFile(path.join(directory, "runtime.tgz"), "Not Found");
	await assert.rejects(
		downloadVerifiedAsset(
			{
				name: "runtime.tgz",
				url: "https://example.com/runtime.tgz",
			},
			directory,
		),
		/archive format/,
	);
	assert.deepEqual(await fs.readdir(directory), []);
});

test("FFmpeg installation uses the isolated archive root, not the ZIP filename", async (t) => {
	const directory = await temporaryDirectory(t);
	const extracted = path.join(directory, "extract");
	await ffmpegFixture(extracted, "ffmpeg-7.1-actual-build-root");
	const output = path.join(directory, "ffmpeg");
	await installFfmpegRoot(extracted, output);
	assert.equal(
		await fs.readFile(path.join(output, "bin/ffmpeg.exe"), "utf8"),
		"fixture",
	);
	assert.deepEqual(await fs.readdir(extracted), []);
});

test("invalid or ambiguous FFmpeg layouts preserve an existing installation", async (t) => {
	const directory = await temporaryDirectory(t);
	const extracted = path.join(directory, "extract");
	const output = await ffmpegFixture(directory, "ffmpeg");
	await fs.mkdir(extracted);
	for (const layout of ["empty", "missing-files", "ambiguous"]) {
		if (layout === "missing-files")
			await fs.mkdir(path.join(extracted, "incomplete"));
		if (layout === "ambiguous") await ffmpegFixture(extracted, "second-root");
		await assert.rejects(
			installFfmpegRoot(extracted, output),
			/FFmpeg archive/,
		);
		assert.equal(
			await fs.readFile(path.join(output, "bin/ffmpeg.exe"), "utf8"),
			"fixture",
		);
	}
});

test("archive cache names cannot escape the download directory", async (t) => {
	const directory = await temporaryDirectory(t);
	const fetch = t.mock.method(
		globalThis,
		"fetch",
		async () => new Response(zipBytes),
	);
	for (const name of ["../escaped.zip", "..\\escaped.zip", "C:escaped.zip"]) {
		await assert.rejects(
			downloadVerifiedAsset({ ...asset, name }, directory),
			/asset name/,
		);
	}
	assert.equal(fetch.mock.callCount(), 0);
});

test("downloads reject unsafe URLs before fetching", async (t) => {
	const directory = await temporaryDirectory(t);
	const fetch = t.mock.method(
		globalThis,
		"fetch",
		async () => new Response(zipBytes),
	);
	for (const url of [
		"http://example.com/archive.zip",
		"https://user:password@example.com/archive.zip",
	]) {
		await assert.rejects(
			downloadVerifiedAsset({ ...asset, url }, directory),
			/HTTPS without credentials/,
		);
	}
	assert.equal(fetch.mock.callCount(), 0);
});

test("unhashed archives require the expected format before entering the cache", async (t) => {
	const directory = await temporaryDirectory(t);
	const fetch = t.mock.method(
		globalThis,
		"fetch",
		async () => new Response("Not Found"),
	);
	for (const [name, hex] of [
		["runtime.tgz", "1f8b0800"],
		["native.tar.xz", "fd377a585a00"],
		["runtime.zip", "504b0304"],
	]) {
		const unsigned = { name, url: `https://example.com/${name}` };
		fetch.mock.mockImplementation(async () => new Response("Not Found"));
		await assert.rejects(
			downloadVerifiedAsset(unsigned, directory),
			/archive format/,
		);
		await assert.rejects(fs.access(path.join(directory, name)));
		const bytes = Buffer.from(hex, "hex");
		fetch.mock.mockImplementation(async () => new Response(bytes));
		const archive = await downloadVerifiedAsset(unsigned, directory);
		assert.deepEqual(await fs.readFile(archive), bytes);
	}
});

test("FFmpeg validation rejects directory links outside its extracted root", async (t) => {
	const directory = await temporaryDirectory(t);
	const extracted = path.join(directory, "extract");
	const root = await ffmpegFixture(extracted, "archive-root");
	const outside = path.join(directory, "outside-bin");
	await fs.rename(path.join(root, "bin"), outside);
	await fs.symlink(outside, path.join(root, "bin"), "junction");
	await assert.rejects(
		installFfmpegRoot(extracted, path.join(directory, "ffmpeg")),
		/FFmpeg archive/,
	);
	assert.equal(
		await fs.readFile(path.join(outside, "ffmpeg.exe"), "utf8"),
		"fixture",
	);
});

test("ONNX setup uses the same pinned versions from official NuGet rather than unavailable GitHub releases", async (t) => {
	const directory = await temporaryDirectory(t);
	const urls = [];
	t.mock.method(globalThis, "fetch", async (url) => {
		urls.push(url);
		throw new Error("stop before downloading test package");
	});
	await assert.rejects(
		setupMacOSOnnxRuntime(directory, "aarch64"),
		/stop before downloading test package/,
	);
	await assert.rejects(
		setupWindowsOnnxRuntime(directory, "x86_64"),
		/stop before downloading test package/,
	);
	await assert.rejects(
		setupLinuxOnnxRuntime(directory, "x86_64"),
		/stop before downloading test package/,
	);
	assert.deepEqual(
		urls,
		["1.24.2", "1.24.2", "1.24.3"].map(
			(version) =>
				`https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${version}/microsoft.ml.onnxruntime.${version}.nupkg`,
		),
	);
});

test("Windows archives avoid the broken PowerShell extraction path", async () => {
	const source = await fs.readFile(
		new URL("./setup.js", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(source, /\bExpand-Archive\b/);
	const { extractWindowsArchive } = await import("./setup.js");
	const calls = [];
	await extractWindowsArchive(
		"C:\\archive with spaces\\runtime.zip",
		"C:\\output [native]",
		async (...args) => {
			calls.push(args);
		},
	);
	assert.equal(calls.length, 1);
	assert.match(calls[0][0], /\\System32\\tar\.exe$/i);
	assert.deepEqual(calls[0][1], [
		"xf",
		"C:\\archive with spaces\\runtime.zip",
		"-C",
		"C:\\output [native]",
	]);
	await assert.rejects(
		extractWindowsArchive("archive.zip", "output", async () => {
			throw new Error("tar extraction failed");
		}),
		/tar extraction failed/,
	);
});

test("Intel macOS keeps its exact runtime version on a verified official package", async (t) => {
	const directory = await temporaryDirectory(t);
	const urls = [];
	t.mock.method(globalThis, "fetch", async (url) => {
		urls.push(url);
		throw new Error("stop before downloading Intel package");
	});
	await assert.rejects(
		setupMacOSOnnxRuntime(directory, "x86_64"),
		/stop before downloading Intel package/,
	);
	assert.deepEqual(urls, [
		"https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/1.23.2/microsoft.ml.onnxruntime.1.23.2.nupkg",
	]);
	const plan = onnxRuntimeAsset("darwin", "x86_64");
	assert.equal(plan.version, "1.23.2");
	assert.equal(plan.runtimeId, "osx-x64");
	assert.equal(
		plan.sha256,
		"25fe172f7fcdf34f2b5b02c8b997f6b88abc282956849d4af4335af23d0c4e4a",
	);
	assert.deepEqual(plan.files, ["libonnxruntime.dylib"]);
});

test("the existing downloader accepts hash-pinned NuGet ZIP bytes", async (t) => {
	const directory = await temporaryDirectory(t);
	t.mock.method(globalThis, "fetch", async () => new Response(zipBytes));
	const archive = await downloadVerifiedAsset(
		{ ...asset, name: "runtime.nupkg" },
		directory,
	);
	assert.deepEqual(await fs.readFile(archive), zipBytes);
});

test("NuGet targets retain pinned versions, exact RIDs, companion libraries and byte hashes", () => {
	for (const [platform, architecture, runtimeId, version] of [
		["linux", "x86_64", "linux-x64", "1.24.3"],
		["linux", "aarch64", "linux-arm64", "1.24.3"],
		["win32", "x86_64", "win-x64", "1.24.2"],
		["win32", "aarch64", "win-arm64", "1.24.2"],
		["darwin", "aarch64", "osx-arm64", "1.24.2"],
	]) {
		const plan = onnxRuntimeAsset(platform, architecture);
		assert.equal(plan.runtimeId, runtimeId);
		assert.equal(plan.version, version);
		assert.equal(
			plan.sha256,
			version === "1.24.3"
				? "e4ab3b236c1b803e1e7167fe9a75caa1b82a2fd4ae82abbd130937c07517bcdb"
				: "782564d3d68e87269ea1812cc94710ad06fe014faf093f01a6f89d0bd58719d3",
		);
		assert.ok(
			plan.files.includes(
				platform === "linux"
					? "libonnxruntime_providers_shared.so"
					: platform === "win32"
						? "onnxruntime_providers_shared.dll"
						: "libonnxruntime.dylib",
			),
		);
	}
	assert.throws(() => onnxRuntimeAsset("linux", "../x64"), /Unsupported/);
	assert.throws(() => onnxRuntimeAsset("linux", "constructor"), /Unsupported/);
	assert.throws(() => onnxRuntimeAsset("constructor", "x86_64"), /Unsupported/);
	assert.throws(() => onnxRuntimeAsset("darwin", "../x64"), /Unsupported/);
});

test("NuGet runtime layout stages exactly the selected architecture and rejects incomplete input before replacement", async (t) => {
	const directory = await temporaryDirectory(t);
	const extracted = path.join(directory, "extract");
	for (const [platform, architecture] of [
		["linux", "x86_64"],
		["linux", "aarch64"],
		["win32", "x86_64"],
		["win32", "aarch64"],
		["darwin", "aarch64"],
		["darwin", "x86_64"],
	]) {
		const plan = onnxRuntimeAsset(platform, architecture);
		const source = path.join(extracted, "runtimes", plan.runtimeId, "native");
		await fs.mkdir(source, { recursive: true });
		for (const name of plan.files)
			await fs.writeFile(path.join(source, name), plan.runtimeId);
		const output = path.join(directory, plan.runtimeId);
		await stageOnnxRuntime(extracted, output, platform, architecture);
		assert.deepEqual((await fs.readdir(output)).sort(), [...plan.files].sort());
		for (const name of plan.files)
			assert.equal(
				await fs.readFile(path.join(output, name), "utf8"),
				plan.runtimeId,
			);
		await fs.writeFile(path.join(source, plan.files.at(-1)), "");
		await assert.rejects(
			stageOnnxRuntime(extracted, output, platform, architecture),
			/ONNX Runtime package/,
		);
		assert.equal(
			await fs.readFile(path.join(output, plan.files[0]), "utf8"),
			plan.runtimeId,
		);
	}
});

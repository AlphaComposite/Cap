import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	downloadVerifiedAsset,
	installFfmpegRoot,
	setupMacOSOnnxRuntime,
} from "./setup.js";

async function temporaryDirectory(t) {
	const directory = await fs.mkdtemp(
		path.join(os.tmpdir(), "cap-native-setup-"),
	);
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

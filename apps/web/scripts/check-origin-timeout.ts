import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
	ORIGIN_SERVICE_HEADER,
	verifyInternalServiceRequest,
} from "../lib/revision-media-token";
import {
	httpOriginClient,
	prepareSourceOnEditorOpen,
} from "../lib/revision-publication-origin";

assert.ok("bun" in process.versions, "Run with real Bun, not Node");
const delayMs = process.argv.includes("--long") ? 310_000 : 25;
const sourceKey = "fixture-owner/fixture-video/original.mp4";
const sourceId = createHash("sha256")
	.update(sourceKey)
	.digest("hex")
	.slice(0, 32);
const identity = {
	sourceKey,
	sha256: "a".repeat(64),
	codec: "h264",
	timebase: "1/90000",
	frameMode: "vfr",
	a1Digest: "b".repeat(64),
	indexId: "fixture-index",
	warmExpiresAt: "2099-01-01T00:00:00.000Z",
};
process.env.REVISION_ORIGIN_SERVICE_SECRET =
	"synthetic-loopback-secret-only-32-bytes";
let responseDelay = delayMs;
let slowBody = false;
let malformed = false;
let requests = 0;
const server = createServer(async (request, response) => {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const body = Buffer.concat(chunks).toString();
	const signed = {
		method: request.method ?? "",
		path: request.url ?? "",
		body,
	};
	const token = request.headers[ORIGIN_SERVICE_HEADER];
	assert.equal(typeof token, "string");
	assert.ok(verifyInternalServiceRequest(String(token), signed));
	assert.equal(
		verifyInternalServiceRequest(String(token), {
			...signed,
			body: `${body} `,
		}),
		false,
	);
	assert.equal(
		verifyInternalServiceRequest(String(token), { ...signed, path: "/forged" }),
		false,
	);
	requests += 1;
	const source = request.url === "/internal/sources/fixture-video/prepare";
	if (source) {
		assert.deepEqual(JSON.parse(body), {
			videoId: "fixture-video",
			sourceKey,
			sourceId,
		});
	}
	const payload = JSON.stringify(
		malformed ? {} : source ? identity : { sha256: identity.sha256 },
	);
	response.setHeader("content-type", "application/json");
	if (slowBody) response.write(payload.slice(0, 1));
	const timer = setTimeout(() => {
		response.end(slowBody ? payload.slice(1) : payload);
	}, responseDelay);
	response.on("close", () => clearTimeout(timer));
});
server.requestTimeout = 0;
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
process.env.CAP_INSTANT_FINISH_ORIGIN_INTERNAL_URL = `http://127.0.0.1:${address.port}`;
const prepare = () =>
	prepareSourceOnEditorOpen({ videoId: "fixture-video", sourceKey });
const write = (signal?: AbortSignal) => {
	const client = httpOriginClient(signal);
	assert.equal(client.signal, signal);
	assert.ok(client.writeCaptions);
	return client.writeCaptions({
		videoId: "fixture-video",
		revisionId: "fixture-revision",
		intentId: "fixture-intent",
		sourceId,
		generation: 1,
		publicationEpoch: 1,
		policyEpoch: 1,
		sourceSha256: identity.sha256,
		captionsVtt: "WEBVTT\n",
	});
};
const nativeTimeout = AbortSignal.timeout;
console.log(
	`Synthetic loopback fixture; real application signedFetch; delay=${delayMs}ms`,
);
try {
	const started = performance.now();
	try {
		assert.deepEqual(await prepare(), identity);
		const elapsed = Math.round(performance.now() - started);
		assert.ok(elapsed >= delayMs);
		console.log(`PASS source prepare/signing/identity after ${elapsed}ms`);
	} catch (error) {
		console.error(
			`FAIL source prepare after ${Math.round(performance.now() - started)}ms`,
			error,
		);
		throw error;
	}
	responseDelay = 500;
	const controller = new AbortController();
	const pending = write(controller.signal);
	setTimeout(() => controller.abort(new Error("fixture caller abort")), 40);
	await assert.rejects(pending, /fixture caller abort/);
	const before = requests;
	await assert.rejects(write(controller.signal), /fixture caller abort/);
	assert.equal(requests, before);
	console.log("PASS caller abort and already-aborted caller");
	let deadlines = 0;
	AbortSignal.timeout = (milliseconds) => {
		assert.equal(milliseconds, 45 * 60 * 1000);
		deadlines += 1;
		return nativeTimeout(40);
	};
	await assert.rejects(prepare(), { name: "TimeoutError" });
	const liveCaller = new AbortController();
	slowBody = true;
	await assert.rejects(write(liveCaller.signal), { name: "TimeoutError" });
	assert.equal(liveCaller.signal.aborted, false);
	assert.equal(deadlines, 2);
	console.log(
		"PASS finite 45-minute deadline (40ms seam), headers and body, with live caller",
	);
	AbortSignal.timeout = nativeTimeout;
	slowBody = false;
	responseDelay = 0;
	malformed = true;
	await assert.rejects(prepare(), /immutable source identity/);
	console.log("PASS malformed identity rejected");
} finally {
	AbortSignal.timeout = nativeTimeout;
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

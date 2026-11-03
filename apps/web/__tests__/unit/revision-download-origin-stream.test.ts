import { describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
	fetch:
		vi.fn<
			(
				url: string,
				options: { headers: Record<string, string>; signal: AbortSignal },
			) => Promise<Response>
		>(),
}));
vi.mock("undici", () => ({ Agent: class {}, fetch: transport.fetch }));

import {
	ORIGIN_SERVICE_HEADER,
	verifyInternalServiceRequest,
} from "@/lib/revision-media-token";
import { httpOriginClient } from "@/lib/revision-publication-origin";

describe("finalized origin download stream transport", () => {
	it("signs the exact internal GET and passes an unbuffered abortable body through", async () => {
		process.env.REVISION_ORIGIN_SERVICE_SECRET =
			"service-token-service-token-svc01";
		process.env.CAP_INSTANT_FINISH_ORIGIN_INTERNAL_URL = "http://origin.test";
		let pulled = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(stream) {
					pulled += 1;
					stream.enqueue(Buffer.from("edited"));
					stream.close();
				},
			},
			{ highWaterMark: 0 },
		);
		const upstream = new Response(body, {
			status: 200,
			headers: { "content-length": "6", "x-cap-revision-id": "revision1234" },
		});
		const buffer = vi.spyOn(upstream, "arrayBuffer");
		transport.fetch.mockResolvedValue(upstream);
		const signal = new AbortController().signal;
		const client = httpOriginClient();
		if (!client.streamDownload) throw new Error("Missing stream transport");
		const response = await client.streamDownload({
			revisionId: "revision1234",
			signal,
		});
		expect(response.body).toBe(body);
		expect(pulled).toBe(0);
		expect(buffer).not.toHaveBeenCalled();
		const call = transport.fetch.mock.calls[0];
		if (!call) throw new Error("Missing transport call");
		const [url, options] = call;
		expect(url).toBe(
			"http://origin.test/internal/revisions/revision1234/download",
		);
		expect(options.signal).toBe(signal);
		expect(
			verifyInternalServiceRequest(
				options.headers[ORIGIN_SERVICE_HEADER] ?? "",
				{ method: "GET", path: "/internal/revisions/revision1234/download" },
			),
		).toBe(true);
		expect(response.headers.get("x-cap-revision-id")).toBe("revision1234");
		expect(await new Response(response.body).text()).toBe("edited");
	});
});

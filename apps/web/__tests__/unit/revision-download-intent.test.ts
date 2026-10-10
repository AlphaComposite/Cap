import { describe, expect, it, vi } from "vitest";
const { fetch } = vi.hoisted(() => ({ fetch: vi.fn(async () => ({ status: 202 })) }));
vi.mock("undici", () => ({ Agent: class {}, fetch }));
vi.mock("@/lib/revision-media-token", () => ({ ORIGIN_SERVICE_HEADER: "x-service", ORIGIN_ATTESTATION_HEADER: "x-attestation", signInternalServiceRequest: () => "signed" }));
vi.mock("@/lib/revision-publication-metadata", () => ({ sha256Hex: vi.fn() }));
import { httpOriginClient } from "@/lib/revision-publication-origin";
describe("download admission intent", () => {
 it("exposes the exact signal used by origin prepare transport", async () => {
  vi.stubEnv("CAP_INSTANT_FINISH_ORIGIN_INTERNAL_URL", "http://origin.test");
  const controller = new AbortController();
  try {
   const client = httpOriginClient(controller.signal);
   expect(client.signal).toBe(controller.signal);
   await expect(client.prepareRevision({ revisionId: "revision" } as never)).rejects.toThrow();
   const [, options] = fetch.mock.calls.at(-1)! as unknown as [string, RequestInit];
   expect(options.signal).toBe(client.signal);
   controller.abort();
   expect(client.signal?.aborted).toBe(true);
  } finally { vi.unstubAllEnvs(); }
 });
 it("sends automatic intent in the signed body and keeps omitted intent explicit", async () => {
  vi.stubEnv("CAP_INSTANT_FINISH_ORIGIN_INTERNAL_URL", "http://origin.test");
  try {
   for (const automatic of [true, undefined]) {
    await httpOriginClient().requestDownload!({ videoId: "video", revisionId: "revision", automatic });
    const [url, options] = fetch.mock.calls.at(-1)! as unknown as [string, RequestInit];
    expect(url).toBe("http://origin.test/internal/revisions/revision/download");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({ videoId: "video", automatic: automatic === true });
   }
  } finally { vi.unstubAllEnvs(); }
 });
});

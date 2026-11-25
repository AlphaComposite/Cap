import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	isSpeakerLabelCanary,
	pollSpeakerLabelTranscript,
	type SpeakerLabelClaim,
} from "@/lib/speaker-label-claim";

const env = vi.hoisted(() => ({ selection: undefined as string | undefined }));
vi.mock("@cap/database", () => ({
	db: () => {
		throw new Error("No database in polling tests");
	},
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		ASSEMBLY_API_KEY: "synthetic",
		CAP_TRANSCRIPT_SPEAKER_LABELS_CANARY: env.selection,
	}),
}));
vi.mock("workflow", () => ({ FatalError: class extends Error {} }));

let claim: SpeakerLabelClaim;
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-25T08:00:00.000Z"));
	env.selection = undefined;
	claim = {
		state: "accepted",
		videoId: "000000000000002",
		ownerId: "000000000000001",
		bucket: null,
		storageIntegrationId: null,
		sourceKey: "private/source/synthetic/original",
		sourceSha256: "a".repeat(64),
		language: "auto",
		token: "00000000-0000-4000-8000-000000000001",
		deadlineMs: Date.now() + 10_000,
		transcriptId: "known-id",
	};
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("limits selection to the named owner, new video, and cutoff", () => {
	const video = {
		id: claim.videoId,
		ownerId: claim.ownerId,
		createdAt: new Date(),
	};
	expect(isSpeakerLabelCanary(video)).toBe(false);
	env.selection = `${claim.ownerId}/${claim.videoId}/${Date.now()}`;
	expect(isSpeakerLabelCanary(video)).toBe(true);
	expect(isSpeakerLabelCanary({ ...video, ownerId: "someone-else" })).toBe(
		false,
	);
	expect(isSpeakerLabelCanary({ ...video, id: "another-video" })).toBe(false);
	expect(
		isSpeakerLabelCanary({ ...video, createdAt: new Date(Date.now() - 1) }),
	).toBe(false);
	env.selection = `${claim.ownerId}/${claim.videoId}/${Date.now() - 3_600_001}`;
	expect(isSpeakerLabelCanary(video)).toBe(false);
});

it.each(["queued", "processing"])(
	"polls %s then completed using only the known ID",
	async (status) => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ id: "known-id", status }))
			.mockResolvedValueOnce(
				Response.json({ id: "known-id", status: "completed", words: [] }),
			);
		vi.stubGlobal("fetch", fetcher);
		const pending = pollSpeakerLabelTranscript(claim);
		await vi.advanceTimersByTimeAsync(3000);
		await expect(pending).resolves.toMatchObject({ status: "completed" });
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			"https://api.assemblyai.com/v2/transcript/known-id",
			"https://api.assemblyai.com/v2/transcript/known-id",
		]);
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
			signal: expect.any(AbortSignal),
		});
	},
);

it.each(["4", "Wed, 25 Nov 2026 08:00:04 GMT"])(
	"respects Retry-After %s without resubmitting",
	async (retryAfter) => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("limited", {
					status: 429,
					headers: { "Retry-After": retryAfter },
				}),
			)
			.mockResolvedValueOnce(
				Response.json({ id: "known-id", status: "completed" }),
			);
		vi.stubGlobal("fetch", fetcher);
		const pending = pollSpeakerLabelTranscript(claim);
		await vi.advanceTimersByTimeAsync(3999);
		expect(fetcher).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		await expect(pending).resolves.toMatchObject({ status: "completed" });
		expect(fetcher).toHaveBeenCalledTimes(2);
	},
);

it.each([429, 503])(
	"stops retrying HTTP %s at the durable deadline",
	async (status) => {
		const fetcher = vi.fn(async () => new Response("retry", { status }));
		vi.stubGlobal("fetch", fetcher);
		const result = expect(pollSpeakerLabelTranscript(claim)).rejects.toThrow(
			"deadline exhausted",
		);
		await vi.advanceTimersByTimeAsync(10_000);
		await result;
		expect(fetcher).toHaveBeenCalledOnce();
	},
);

it.each(["different-id", undefined])(
	"rejects mismatched or missing result ID %s",
	async (id) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ id, status: "completed" })),
		);
		await expect(pollSpeakerLabelTranscript(claim)).rejects.toThrow("mismatch");
	},
);

it("returns terminal provider failure without a new submission", async () => {
	const fetcher = vi.fn(async () =>
		Response.json({
			id: "known-id",
			status: "error",
			error: "provider failure",
		}),
	);
	vi.stubGlobal("fetch", fetcher);
	await expect(pollSpeakerLabelTranscript(claim)).resolves.toMatchObject({
		status: "error",
	});
	expect(fetcher).toHaveBeenCalledOnce();
});

it("does no IO for an unknown ID or an exhausted deadline", async () => {
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	await expect(
		pollSpeakerLabelTranscript({ ...claim, transcriptId: undefined }),
	).rejects.toThrow("unknown outcome");
	await expect(
		pollSpeakerLabelTranscript({ ...claim, deadlineMs: Date.now() }),
	).rejects.toThrow("deadline exhausted");
	expect(fetcher).not.toHaveBeenCalled();
});

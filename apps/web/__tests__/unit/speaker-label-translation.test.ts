import { beforeEach, describe, expect, it, vi } from "vitest";
import { translateTranscript } from "@/actions/videos/translate-transcript";
import { parseTranscriptCuePayload } from "@/lib/transcript-vtt";

const state = vi.hoisted(() => ({
	original: "",
	response: "",
	generateText: vi.fn(),
	putObject: vi.fn(),
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: async () => [{ video: { id: "video", ownerId: "owner" } }],
			}),
		}),
	}),
}));
vi.mock("@cap/database/schema", () => ({ videos: { id: "id" } }));
vi.mock("@cap/web-domain", () => ({
	Policy: { withPublicPolicy: () => (effect: unknown) => effect },
}));
vi.mock("@cap/web-backend", async () => {
	const { Effect, Option } = await import("effect");
	return {
		provideOptionalAuth: (effect: unknown) => effect,
		VideosPolicy: Effect.succeed({ canView: () => Effect.void }),
		Storage: {
			getAccessForVideo: () =>
				Effect.succeed([
					{
						getObject: (key: string) =>
							Effect.succeed(
								key.endsWith("transcription.vtt")
									? Option.some(state.original)
									: Option.none(),
							),
						putObject: (...args: unknown[]) => {
							state.putObject(...args);
							return Effect.void;
						},
					},
				]),
		},
	};
});
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return {
		runPromise: Effect.runPromise,
		runPromiseExit: Effect.runPromiseExit,
	};
});
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/ai/provider", () => ({ isAiConfigured: () => true }));
vi.mock("@/lib/ai/run", () => ({
	runWithAiProviders: (
		_operation: string,
		run: (selection: { model: () => object }) => Promise<unknown>,
	) => run({ model: () => ({}) }),
}));
vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: async () => false,
	RATE_LIMIT_IDS: { TRANSLATE_TRANSCRIPT: "translate" },
}));
vi.mock("ai", () => ({ generateText: state.generateText }));
const vtt = (payload: string) =>
	`WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n${payload}\n\n`;
beforeEach(() => {
	state.generateText.mockImplementation(async () => ({ text: state.response }));
});

describe("translation speaker compatibility", () => {
	it("removes source attribution before prompt and never trusts model labels", async () => {
		state.original = vtt(
			"<v cap-speaker-A>&lt;v cap-speaker-B&gt;literal&lt;/v&gt; &amp;amp;</v>",
		);
		state.response = vtt(
			"<v cap-speaker-FORGED>Bonjour &lt;b&gt;literal&lt;/b&gt;</v>",
		);
		const result = await translateTranscript(
			"video" as Parameters<typeof translateTranscript>[0],
			"fr",
		);
		expect(result.success).toBe(true);
		const prompt = state.generateText.mock.calls[0]?.[0]?.prompt as string;
		expect(prompt).not.toContain("<v");
		expect(prompt).not.toContain("cap-speaker-A");
		expect(prompt).toContain(
			"&lt;v cap-speaker-B&gt;literal&lt;/v&gt; &amp;amp;",
		);
		expect(result.translatedVtt).not.toContain("cap-speaker-FORGED");
		const payload = result.translatedVtt?.split("\n")[4] ?? "";
		expect(parseTranscriptCuePayload(payload)).toEqual({
			text: "Bonjour <b>literal</b>",
			speaker: null,
		});
		expect(state.putObject).toHaveBeenCalledWith(
			"owner/video/transcription.fr.vtt",
			result.translatedVtt,
			{ contentType: "text/vtt" },
		);
	});

	it("keeps unmarked input and output byte identical", async () => {
		state.original = vtt("Hello &amp; ordinary");
		state.response = vtt("Bonjour &amp; ordinary").trim();
		const result = await translateTranscript(
			"video" as Parameters<typeof translateTranscript>[0],
			"fr",
		);
		expect(state.generateText.mock.calls[0]?.[0]?.prompt).toContain(
			state.original,
		);
		expect(result.translatedVtt).toBe(state.response);
	});
});

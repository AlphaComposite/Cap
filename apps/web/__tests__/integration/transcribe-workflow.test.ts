import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assemblyAIEditResponse } from "../fixtures/assemblyai-edit-response";

const mocks = vi.hoisted(() => ({
	transcribe: vi.fn(),
	submit: vi.fn(),
	waitUntilReady: vi.fn(),
	putObject: vi.fn(),
	deleteObject: vi.fn(),
	getInternalSignedObjectUrl: vi.fn(),
	startAiGeneration: vi.fn(),
	updates: [] as Record<string, unknown>[],
}));

const schemaMocks = vi.hoisted(() => ({
	sourceRelocation: { videoId: "sourceRelocation.videoId" },
	videos: {
		id: "videos.id",
		metadata: "videos.metadata",
		transcriptionStatus: "videos.transcriptionStatus",
		updatedAt: "videos.updatedAt",
	},
	organizations: { id: "organizations.id" },
	videoUploads: { videoId: "videoUploads.videoId" },
	videoEdits: {
		videoId: "videoEdits.videoId",
		editSpec: "videoEdits.editSpec",
	},
}));

const videoRow = vi.hoisted(() => ({
	id: "video-123",
	ownerId: "user-456",
	duration: 4,
	createdAt: new Date(),
	settings: null,
	source: { type: "webMP4" },
	isScreenshot: false,
	transcriptionStatus: "COMPLETE",
	updatedAt: new Date("2026-07-30T00:00:00.000Z"),
	metadata: {
		editTranscriptBackfill: {
			status: "processing",
			requestId: "request-1",
			requestedAt: "2026-07-30T00:00:00.000Z",
		},
	},
}));

const state = vi.hoisted(() => ({
	editRows: [] as unknown[],
	speakerLabels: false,
	claim: null as Record<string, unknown> | null,
	failPersist: false,
	failTransition: false,
	sourceSha256: "a".repeat(64),
	sourceKey: "private/source/video-123/original" as string | null,
	uploadPhase: "complete" as string | null,
	queries: [] as string[],
	transaction: Promise.resolve() as Promise<unknown>,
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		ASSEMBLY_API_KEY: "test-assembly-api-key",
		CAP_TRANSCRIPT_SPEAKER_LABELS: state.speakerLabels,
		CAP_TRANSCRIPT_SPEAKER_LABELS_CANARY: state.speakerLabels
			? `user-456/video-123/${videoRow.createdAt.getTime() - 1000}`
			: undefined,
		NEXTAUTH_SECRET: "test-secret-with-enough-entropy",
	}),
}));

vi.mock("@cap/database/schema", () => schemaMocks);
vi.mock("@/lib/source-prepare-worker", () => ({
	enqueueSourceCaptionsAfterTranscript: vi.fn(async () => undefined),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		execute: async (query: {
			strings: TemplateStringsArray;
			values: unknown[];
		}) => {
			const text = query.strings.join("?");
			state.queries.push(text);
			if (text.includes("FROM outbox")) {
				return [state.claim ? [{ payload: structuredClone(state.claim) }] : []];
			}
			if (text.includes("FROM videos v")) {
				return [
					[
						{
							videoId: videoRow.id,
							ownerId: videoRow.ownerId,
							bucket: null,
							storageIntegrationId: null,
							sourceKey: state.sourceKey,
							sourceSha256: state.sourceSha256,
							sourceType: videoRow.source.type,
							uploadPhase: state.uploadPhase,
							liveTranscript: null,
							edited: state.editRows.length,
						},
					],
				];
			}
			if (text.includes("INSERT INTO outbox")) {
				state.claim = JSON.parse(String(query.values[2]));
			}
			if (text.includes("UPDATE outbox")) {
				const payload = JSON.parse(String(query.values[0]));
				if (state.failTransition && payload.state === "submitting")
					throw new Error("submission marker write outage");
				if (state.failPersist && payload.transcriptId)
					throw new Error("accepted ID write outage");
				state.claim = payload;
			}
			return [[]];
		},
		transaction: async (run: (tx: unknown) => Promise<unknown>) => {
			const { db } = await import("@cap/database");
			const pending = state.transaction.then(() => run(db()));
			state.transaction = pending.catch(() => {});
			return pending;
		},
		select: () => {
			const query = {
				from: (table: unknown) => {
					if (table === schemaMocks.sourceRelocation)
						return { where: async () => [] };
					if (table === schemaMocks.videoUploads) {
						return {
							where: () => ({ limit: async () => [] }),
						};
					}
					if (table === schemaMocks.videoEdits) {
						return { where: async () => state.editRows };
					}
					return {
						leftJoin: () => ({
							where: async () => [{ video: videoRow, orgSettings: null }],
						}),
						where: async () => [videoRow],
					};
				},
			};
			return query;
		},
		update: () => ({
			set: (values: Record<string, unknown>) => {
				mocks.updates.push(values);
				return { where: async () => [{ affectedRows: 1 }] };
			},
		}),
	}),
}));

vi.mock("drizzle-orm", () => ({
	and: (...conditions: unknown[]) => ({ conditions }),
	eq: (field: unknown, value: unknown) => ({ field, value }),
	isNull: (field: unknown) => ({ isNull: field }),
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings,
		values,
	}),
}));

vi.mock("server-only", () => ({}));

vi.mock("workflow", async () => {
	const { runInNewContext } = await import("node:vm");
	const { RetryableError } =
		await vi.importActual<typeof import("workflow")>("workflow");
	return {
		FatalError: runInNewContext("(class FatalError extends Error {})"),
		RetryableError,
	};
});

vi.mock("workflow/api", () => ({
	start: vi.fn(),
}));

vi.mock("assemblyai", () => ({
	AssemblyAI: class {
		transcripts = {
			transcribe: mocks.transcribe,
			submit: mocks.submit,
			waitUntilReady: mocks.waitUntilReady,
		};
	},
}));

vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: () => ({
			pipe: (runner: (value: unknown) => unknown) =>
				runner([
					{
						putObject: mocks.putObject,
						deleteObject: mocks.deleteObject,
						getInternalSignedObjectUrl: mocks.getInternalSignedObjectUrl,
					},
				]),
		}),
	},
}));

vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: (value: unknown) => Promise.resolve(value),
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));

vi.mock("@/lib/media-client", () => ({
	isMediaServerConfigured: () => true,
	probeVideoViaMediaServer: async () => ({
		audioCodec: "aac",
		videoCodec: "h264",
		duration: 4,
		audioChannels: 2,
		sampleRate: 48_000,
	}),
	extractAudioViaMediaServer: async () => Buffer.from("audio"),
	checkHasAudioTrackViaMediaServer: async () => true,
}));

vi.mock("@/lib/audio-extract", () => ({
	checkHasAudioTrack: async () => true,
	extractAudioFromUrl: async () => ({
		filePath: "/tmp/audio.mp3",
		cleanup: async () => {},
	}),
}));

vi.mock("@/lib/audio-enhance", () => ({
	ENHANCED_AUDIO_CONTENT_TYPE: "audio/mpeg",
	ENHANCED_AUDIO_EXTENSION: "mp3",
	enhanceAudioFromUrl: async () => Buffer.from(""),
}));

vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: mocks.startAiGeneration,
}));

function pipeValue(value: unknown) {
	return { pipe: (runner: (input: unknown) => unknown) => runner(value) };
}

async function speakerSubmitBinding() {
	const { loadSpeakerLabelSource, reserveSpeakerLabelRecording } = await import(
		"@/lib/speaker-label-claim"
	);
	const reservation = await reserveSpeakerLabelRecording(videoRow, "auto");
	return [
		await loadSpeakerLabelSource("video-123", "user-456"),
		reservation.token,
	] as const;
}

let deliverStep = async (
	_message: unknown,
	_metadata: unknown,
): Promise<unknown> => undefined;

async function stepRuntime(loseCompletion = false) {
	const events: Array<{
		eventType: string;
		correlationId?: string;
		eventData?: { result?: unknown };
	}> = [];
	const steps = new Map<
		string,
		{ attempt: number; input: unknown; startedAt: Date; status: string }
	>();
	const world = {
		createQueueHandler: (_prefix: string, handler: typeof deliverStep) => {
			deliverStep = handler;
			return () => new Response();
		},
		events: {
			create: vi.fn(async (_runId: string, event: (typeof events)[number]) => {
				if (loseCompletion && event.eventType === "step_completed") {
					throw new Error("event storage outage after acceptance");
				}
				events.push(event);
				const step = steps.get(event.correlationId ?? "");
				if (step && event.eventType === "step_started") {
					step.attempt++;
					return { step: { ...step } };
				}
				if (step) step.status = event.eventType;
				return {};
			}),
		},
		queue: vi.fn(async () => ({ messageId: "test-message" })),
	};
	Reflect.set(globalThis, Symbol.for("@workflow/world//cache"), world);
	Reflect.set(globalThis, Symbol.for("@workflow/world//stubbedCache"), world);
	await import("@workflow/core/runtime");
	const { registerStepFunction } = await import("@workflow/core/private");
	const { dehydrateStepArguments, hydrateStepReturnValue } = await import(
		"@workflow/core/serialization"
	);
	return {
		events,
		world,
		async register(
			name: string,
			fn: Parameters<typeof registerStepFunction>[1],
			args: unknown[],
		) {
			registerStepFunction(name, fn);
			steps.set(name, {
				attempt: 0,
				input: await dehydrateStepArguments({ args }, "test-run", undefined),
				startedAt: new Date(),
				status: "pending",
			});
		},
		deliver: (name: string) =>
			deliverStep(
				{
					workflowName: "test-workflow",
					workflowRunId: "test-run",
					workflowStartedAt: Date.now(),
					stepId: name,
				},
				{
					queueName: `__wkf_step_${name}`,
					attempt: 1,
					requestId: "test-request",
				},
			),
		result: (name: string) =>
			hydrateStepReturnValue(
				events.find(
					(event) =>
						event.correlationId === name &&
						event.eventType === "step_completed",
				)?.eventData?.result,
				"test-run",
				undefined,
			),
	};
}

describe("transcribeVideoWorkflow", () => {
	afterEach(() => {
		Reflect.deleteProperty(globalThis, Symbol.for("@workflow/world//cache"));
		Reflect.deleteProperty(
			globalThis,
			Symbol.for("@workflow/world//stubbedCache"),
		);
	});
	beforeEach(() => {
		mocks.updates.length = 0;
		videoRow.transcriptionStatus = "PROCESSING";
		state.editRows = [];
		state.speakerLabels = false;
		mocks.submit.mockReset();
		state.claim = null;
		state.failPersist = false;
		state.failTransition = false;
		state.sourceSha256 = "a".repeat(64);
		state.sourceKey = "private/source/video-123/original";
		state.uploadPhase = "complete";
		state.queries = [];
		state.transaction = Promise.resolve();
		mocks.waitUntilReady.mockReset();
		mocks.submit.mockResolvedValue({ id: "labeled-job" });
		mocks.waitUntilReady.mockResolvedValue({
			...assemblyAIEditResponse,
			id: "labeled-job",
			audio_duration: 4,
		});
		mocks.transcribe.mockResolvedValue({
			...assemblyAIEditResponse,
			audio_duration: 4,
		});
		mocks.putObject.mockImplementation(() => pipeValue(undefined));
		mocks.deleteObject.mockImplementation(() => pipeValue(undefined));
		mocks.getInternalSignedObjectUrl.mockImplementation(() =>
			pipeValue("https://storage.test/object"),
		);
		mocks.startAiGeneration.mockResolvedValue({ success: true, message: "ok" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.startsWith("https://api.assemblyai.com/")
					? Response.json(await mocks.waitUntilReady(url.split("/").at(-1)))
					: new Response(new ArrayBuffer(8)),
			),
		);
	});

	it("polls AssemblyAI every 1000 ms", async () => {
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		});
		expect(mocks.transcribe.mock.calls[0]?.[1]).toEqual({
			pollingInterval: 1000,
		});
	});

	it("uses separate labeled submit and same-job polling when the env gate is mocked open", async () => {
		state.speakerLabels = true;
		mocks.waitUntilReady.mockResolvedValueOnce({
			...assemblyAIEditResponse,
			id: "labeled-job",
			words: assemblyAIEditResponse.words.map((word) => ({
				...word,
				speaker: "A",
			})),
		});
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		});
		expect(mocks.transcribe).not.toHaveBeenCalled();
		const { getAssemblyAITranscriptionOptions } = await import(
			"@/lib/assemblyai"
		);
		expect(mocks.submit).toHaveBeenCalledExactlyOnceWith({
			audio: expect.any(Buffer),
			...getAssemblyAITranscriptionOptions("auto"),
			disfluencies: true,
			speaker_labels: true,
		});
		expect(mocks.waitUntilReady).toHaveBeenCalledExactlyOnceWith("labeled-job");
		expect(mocks.putObject).toHaveBeenCalledWith(
			"user-456/video-123/transcription.vtt",
			expect.stringContaining("<v cap-speaker-A>"),
			expect.anything(),
		);
	});

	it("keeps successful text when the labeled job returns no attribution", async () => {
		state.speakerLabels = true;
		mocks.waitUntilReady.mockResolvedValueOnce({
			...assemblyAIEditResponse,
			id: "labeled-job",
			words: assemblyAIEditResponse.words.map((word) => ({
				text: word.text,
				start: word.start,
				end: word.end,
				confidence: word.confidence,
			})),
		});
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		});
		expect(mocks.submit).toHaveBeenCalledOnce();
		expect(mocks.transcribe).not.toHaveBeenCalled();
		const vtt = mocks.putObject.mock.calls.find((call) =>
			String(call[0]).endsWith("transcription.vtt"),
		)?.[1];
		expect(vtt).toContain("this is a real example.");
		expect(vtt).not.toContain("<v ");
	});

	it.each([
		"connection lost after acceptance",
		"no spoken audio",
		"HTTP Error: 400",
	])(
		"never falls back or polls after ambiguous submit: %s",
		async (message) => {
			state.speakerLabels = true;
			mocks.submit.mockRejectedValueOnce(new Error(message));
			const { transcribeVideoWorkflow } = await import(
				"@/workflows/transcribe"
			);
			await expect(
				transcribeVideoWorkflow({
					videoId: "video-123",
					userId: "user-456",
					aiGenerationEnabled: false,
				}),
			).rejects.toThrow("submission outcome unknown");
			expect(mocks.submit).toHaveBeenCalledOnce();
			expect(mocks.waitUntilReady).not.toHaveBeenCalled();
			expect(mocks.transcribe).not.toHaveBeenCalled();
			expect(mocks.updates).toContainEqual({ transcriptionStatus: "ERROR" });
		},
	);

	it("pins the rollout decision before later env changes", async () => {
		state.speakerLabels = true;
		vi.mocked(fetch).mockImplementationOnce(async () => {
			state.speakerLabels = false;
			return new Response("audio");
		});
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		});
		expect(mocks.submit).toHaveBeenCalledOnce();
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it("does not pay twice when a fresh workflow repeats a labeled recording", async () => {
		state.speakerLabels = true;
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const payload = {
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		};
		await transcribeVideoWorkflow(payload);
		await transcribeVideoWorkflow(payload);
		expect(mocks.submit).toHaveBeenCalledOnce();
	});

	it("reserves before extraction so flag removal cannot race a legacy paid pass", async () => {
		state.speakerLabels = true;
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const payload = {
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		};
		let competingError: unknown;
		vi.mocked(fetch).mockImplementationOnce(async () => {
			state.speakerLabels = false;
			try {
				await transcribeVideoWorkflow(payload);
			} catch (error) {
				competingError = error;
			}
			return new Response("audio");
		});
		await transcribeVideoWorkflow(payload);
		expect(mocks.transcribe).not.toHaveBeenCalled();
		expect(mocks.submit).toHaveBeenCalledOnce();
		expect(competingError).toMatchObject({
			message: expect.stringContaining("outcome unknown"),
		});
	});

	it("does not backfill an already completed transcript selected later", async () => {
		state.speakerLabels = true;
		videoRow.transcriptionStatus = "COMPLETE";
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		await expect(
			transcribeVideoWorkflow({
				videoId: "video-123",
				userId: "user-456",
				aiGenerationEnabled: false,
			}),
		).rejects.toThrow("cannot backfill");
		expect(mocks.submit).not.toHaveBeenCalled();
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it("leaves completed labeled output untouched on a delayed workflow", async () => {
		state.speakerLabels = true;
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const payload = {
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		};
		await transcribeVideoWorkflow(payload);
		videoRow.transcriptionStatus = "COMPLETE";
		mocks.putObject.mockClear();
		await expect(transcribeVideoWorkflow(payload)).resolves.toMatchObject({
			success: true,
		});
		expect(mocks.putObject).not.toHaveBeenCalled();
		expect(mocks.submit).toHaveBeenCalledOnce();
		expect(mocks.waitUntilReady).toHaveBeenCalledOnce();
	});

	it("the installed handler waits for source preservation without a paid call", async () => {
		const runtime = await stepRuntime();
		const { prepareSpeakerLabelSource } = await import(
			"@/workflows/transcribe"
		);
		state.sourceKey = null;
		await runtime.register("source", prepareSpeakerLabelSource, [
			"video-123",
			"user-456",
			videoRow,
		]);
		expect(await runtime.deliver("source")).toMatchObject({
			timeoutSeconds: expect.any(Number),
		});
		expect(mocks.submit).not.toHaveBeenCalled();
		state.sourceKey = "private/source/video-123/original";
		state.uploadPhase = null;
		await runtime.deliver("source");
		expect(await runtime.result("source")).toMatchObject({
			sourceKey: state.sourceKey,
		});
		expect(prepareSpeakerLabelSource.maxRetries).toBe(60);
	});

	it("holds a competing submit while the first provider outcome is unknown", async () => {
		const { submitSpeakerLabeledTranscription } = await import(
			"@/workflows/transcribe"
		);
		const [source, token] = await speakerSubmitBinding();
		let accept: (value: { id: string }) => void = () => {};
		mocks.submit.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					accept = resolve;
				}),
		);
		const first = submitSpeakerLabeledTranscription(
			"https://storage.test/audio",
			"auto",
			source,
			token,
		);
		await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledOnce());
		await expect(
			submitSpeakerLabeledTranscription(
				"https://storage.test/audio",
				"auto",
				source,
				token,
			),
		).rejects.toThrow("outcome unknown");
		accept({ id: "labeled-job" });
		await expect(first).resolves.toBe("labeled-job");
		expect(mocks.submit).toHaveBeenCalledOnce();
		const lock = state.queries.findIndex(
			(query) =>
				query.includes("SELECT id FROM videos") && query.includes("FOR UPDATE"),
		);
		const insert = state.queries.findIndex((query) =>
			query.includes("INSERT INTO outbox"),
		);
		expect(lock).toBeGreaterThanOrEqual(0);
		expect(insert).toBeGreaterThan(lock);
	});

	it("rejects a stale reservation token without consuming the owner's reservation", async () => {
		const { submitSpeakerLabeledTranscription } = await import(
			"@/workflows/transcribe"
		);
		const [source, token] = await speakerSubmitBinding();
		await expect(
			submitSpeakerLabeledTranscription(
				"https://storage.test/audio",
				"auto",
				source,
				"stale-token",
			),
		).rejects.toThrow("reservation changed");
		expect(mocks.submit).not.toHaveBeenCalled();
		await expect(
			submitSpeakerLabeledTranscription(
				"https://storage.test/audio",
				"auto",
				source,
				token,
			),
		).resolves.toBe("labeled-job");
		expect(mocks.submit).toHaveBeenCalledOnce();
	});

	it("requires a committed submitting marker before any provider request", async () => {
		state.speakerLabels = true;
		state.failTransition = true;
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const payload = {
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		};
		await expect(transcribeVideoWorkflow(payload)).rejects.toThrow(
			"submission marker write outage",
		);
		state.failTransition = false;
		state.speakerLabels = false;
		await expect(transcribeVideoWorkflow(payload)).rejects.toThrow(
			"outcome unknown",
		);
		expect(mocks.submit).not.toHaveBeenCalled();
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it("holds malformed durable claims rather than treating them as no claim", async () => {
		state.claim = { videoId: "video-123", state: "accepted" };
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		await expect(
			transcribeVideoWorkflow({
				videoId: "video-123",
				userId: "user-456",
				aiGenerationEnabled: false,
			}),
		).rejects.toThrow("requires reconciliation");
		expect(mocks.submit).not.toHaveBeenCalled();
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it.each(["ambiguous", "accepted-id-write"])(
		"holds %s across fresh runs and flag removal",
		async (failure) => {
			state.speakerLabels = true;
			if (failure === "ambiguous")
				mocks.submit.mockRejectedValueOnce(new Error("lost response"));
			else state.failPersist = true;
			const { transcribeVideoWorkflow } = await import(
				"@/workflows/transcribe"
			);
			const payload = {
				videoId: "video-123",
				userId: "user-456",
				aiGenerationEnabled: false,
			};
			await expect(transcribeVideoWorkflow(payload)).rejects.toThrow(
				"outcome unknown",
			);
			state.speakerLabels = false;
			state.failPersist = false;
			await expect(transcribeVideoWorkflow(payload)).rejects.toThrow(
				"outcome unknown",
			);
			expect(state.claim).not.toHaveProperty("transcriptId");
			expect(mocks.submit).toHaveBeenCalledOnce();
			expect(mocks.transcribe).not.toHaveBeenCalled();
		},
	);

	it("recovers the durable accepted ID after a polling outage and flag removal", async () => {
		state.speakerLabels = true;
		mocks.waitUntilReady.mockRejectedValueOnce(new Error("poll outage"));
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const payload = {
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		};
		await expect(transcribeVideoWorkflow(payload)).rejects.toThrow(
			"poll outage",
		);
		state.speakerLabels = false;
		mocks.getInternalSignedObjectUrl.mockClear();
		await expect(transcribeVideoWorkflow(payload)).resolves.toMatchObject({
			success: true,
		});
		expect(mocks.getInternalSignedObjectUrl).not.toHaveBeenCalled();
		expect(mocks.submit).toHaveBeenCalledOnce();
		expect(mocks.waitUntilReady.mock.calls).toEqual([
			["labeled-job"],
			["labeled-job"],
		]);
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it("refuses a stale source binding before another paid submit or artifact write", async () => {
		state.speakerLabels = true;
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const payload = {
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		};
		await transcribeVideoWorkflow(payload);
		mocks.putObject.mockClear();
		state.sourceSha256 = "b".repeat(64);
		await expect(transcribeVideoWorkflow(payload)).rejects.toThrow(
			"source changed",
		);
		expect(mocks.submit).toHaveBeenCalledOnce();
		expect(
			mocks.putObject.mock.calls.filter((call) =>
				String(call[0]).includes("transcription"),
			),
		).toHaveLength(0);
	});

	it("does not reset a known job's deadline on a new run", async () => {
		state.speakerLabels = true;
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const payload = {
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		};
		await transcribeVideoWorkflow(payload);
		state.claim = { ...state.claim, deadlineMs: Date.now() - 1 };
		state.speakerLabels = false;
		await expect(transcribeVideoWorkflow(payload)).rejects.toThrow(
			"deadline exhausted",
		);
		expect(mocks.submit).toHaveBeenCalledOnce();
		expect(mocks.waitUntilReady).toHaveBeenCalledOnce();
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it("holds early and backfill paths when this recording has an active claim", async () => {
		state.speakerLabels = true;
		const { transcribeVideoWorkflow, backfillEditTranscriptWorkflow } =
			await import("@/workflows/transcribe");
		const payload = {
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		};
		await transcribeVideoWorkflow(payload);
		state.speakerLabels = false;
		await expect(
			transcribeVideoWorkflow({ ...payload, earlyFromSegments: true }),
		).rejects.toThrow("claim holds");
		videoRow.transcriptionStatus = "COMPLETE";
		await expect(
			backfillEditTranscriptWorkflow({
				videoId: "video-123",
				userId: "user-456",
				requestId: "request-1",
			}),
		).resolves.toEqual({ success: false });
		expect(mocks.submit).toHaveBeenCalledOnce();
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it("the installed step handler retries polling the durable job ID without another submit", async () => {
		const runtime = await stepRuntime();
		const {
			submitSpeakerLabeledTranscription,
			pollSpeakerLabeledTranscription,
		} = await import("@/workflows/transcribe");
		expect(submitSpeakerLabeledTranscription.maxRetries).toBe(0);
		await runtime.register("submit", submitSpeakerLabeledTranscription, [
			"https://storage.test/audio",
			"auto",
			...(await speakerSubmitBinding()),
		]);
		await runtime.deliver("submit");
		const jobId: unknown = await runtime.result("submit");
		expect(jobId).toBe("labeled-job");
		await runtime.register("poll", pollSpeakerLabeledTranscription, [
			jobId,
			4000,
			"video-123",
		]);
		mocks.waitUntilReady.mockRejectedValueOnce(new Error("poll outage"));
		expect(await runtime.deliver("poll")).toEqual({ timeoutSeconds: 1 });
		await runtime.deliver("poll");
		expect(mocks.submit).toHaveBeenCalledOnce();
		expect(mocks.waitUntilReady.mock.calls).toEqual([
			["labeled-job"],
			["labeled-job"],
		]);
		expect(await runtime.result("poll")).toMatchObject({
			vtt: expect.stringContaining("this is a real example."),
		});
		expect(runtime.events.map((event) => event.eventType)).toEqual([
			"step_started",
			"step_completed",
			"step_started",
			"step_retrying",
			"step_started",
			"step_completed",
		]);
	});

	it("the installed step handler never re-executes ambiguous submit on redelivery", async () => {
		const runtime = await stepRuntime();
		const { submitSpeakerLabeledTranscription } = await import(
			"@/workflows/transcribe"
		);
		mocks.submit.mockRejectedValueOnce(new Error("acceptance response lost"));
		await runtime.register("submit", submitSpeakerLabeledTranscription, [
			"https://storage.test/audio",
			"auto",
			...(await speakerSubmitBinding()),
		]);
		await runtime.deliver("submit");
		await runtime.deliver("submit");
		expect(mocks.submit).toHaveBeenCalledOnce();
		expect(mocks.waitUntilReady).not.toHaveBeenCalled();
		expect(mocks.transcribe).not.toHaveBeenCalled();
		expect(runtime.events.map((event) => event.eventType)).not.toContain(
			"step_retrying",
		);
		expect(runtime.events.map((event) => event.eventType)).toContain(
			"step_failed",
		);
	});

	it("the installed step handler fails closed if accepted ID persistence fails", async () => {
		const runtime = await stepRuntime(true);
		const { submitSpeakerLabeledTranscription } = await import(
			"@/workflows/transcribe"
		);
		await runtime.register("submit", submitSpeakerLabeledTranscription, [
			"https://storage.test/audio",
			"auto",
			...(await speakerSubmitBinding()),
		]);
		await expect(runtime.deliver("submit")).rejects.toThrow(
			"event storage outage",
		);
		await runtime.deliver("submit");
		expect(mocks.submit).toHaveBeenCalledOnce();
		expect(mocks.waitUntilReady).not.toHaveBeenCalled();
		expect(runtime.events.map((event) => event.eventType)).toEqual([
			"step_started",
			"step_started",
			"step_failed",
		]);
	});

	it.each([undefined, ""])(
		"fails closed on a submit response with ID %s",
		async (id) => {
			state.speakerLabels = true;
			mocks.submit.mockResolvedValueOnce({ id });
			const { transcribeVideoWorkflow } = await import(
				"@/workflows/transcribe"
			);
			await expect(
				transcribeVideoWorkflow({
					videoId: "video-123",
					userId: "user-456",
					aiGenerationEnabled: false,
				}),
			).rejects.toThrow("submission outcome unknown");
			expect(mocks.submit).toHaveBeenCalledOnce();
			expect(mocks.waitUntilReady).not.toHaveBeenCalled();
			expect(mocks.transcribe).not.toHaveBeenCalled();
		},
	);

	it("persists captions and the word transcript from a single paid pass", async () => {
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");

		const result = await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		});

		expect(result.success).toBe(true);
		expect(mocks.transcribe).toHaveBeenCalledTimes(1);
		expect(mocks.submit).not.toHaveBeenCalled();
		expect(mocks.waitUntilReady).not.toHaveBeenCalled();
		expect(mocks.transcribe.mock.calls[0]?.[0]).toMatchObject({
			disfluencies: true,
			speech_models: ["universal-3-5-pro", "universal-2"],
		});
		expect(mocks.transcribe.mock.calls[0]?.[0]).not.toHaveProperty(
			"speaker_labels",
		);

		const writes = new Map(
			mocks.putObject.mock.calls.map((call) => [call[0] as string, call[1]]),
		);
		expect(
			[...writes.keys()].filter((key) => key.includes("transcription")),
		).toEqual([
			"user-456/video-123/transcription.vtt",
			"user-456/video-123/transcription.edit.v3.json",
		]);

		const vtt = writes.get("user-456/video-123/transcription.vtt") as string;
		expect(vtt.startsWith("WEBVTT")).toBe(true);
		expect(vtt).toContain("this is a real example.");
		expect(vtt).not.toContain("Um,");

		const { parseEditTranscript } = await import("@/lib/edit-transcript");
		const { decryptEditTranscriptObject } = await import(
			"@/lib/edit-transcript-storage"
		);
		const encrypted = writes.get(
			"user-456/video-123/transcription.edit.v3.json",
		) as string;
		expect(encrypted).not.toContain("this is a real example");
		const stored = parseEditTranscript(
			decryptEditTranscriptObject(encrypted, "user-456", "video-123") ?? "",
		);
		expect(stored).toMatchObject({ version: 3, durationMs: 4_000 });
		// verbatim: fillers stay in the stored words even though captions drop them
		expect(stored?.words.map((word) => word.text)).toContain("Um,");
		expect(stored?.words).toHaveLength(9);

		expect(mocks.updates.at(-1)).toEqual({ transcriptionStatus: "COMPLETE" });
	});

	it("handles no-speech errors across workflow realms without retrying transcription", async () => {
		const { FatalError } = await import("workflow");
		expect(new FatalError("no spoken audio")).not.toBeInstanceOf(Error);
		mocks.transcribe.mockResolvedValueOnce({
			id: "silent-transcript",
			status: "error",
			error:
				"language_detection cannot be performed on files with no spoken audio.",
		});

		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const result = await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: true,
		});

		expect(result).toEqual({
			success: true,
			message: "Video has no spoken audio - skipped transcription",
		});
		expect(mocks.transcribe).toHaveBeenCalledTimes(1);
		expect(mocks.updates).toContainEqual({ transcriptionStatus: "NO_AUDIO" });
		expect(mocks.updates).not.toContainEqual({ transcriptionStatus: "ERROR" });
		expect(mocks.startAiGeneration).not.toHaveBeenCalled();
		expect(mocks.deleteObject).toHaveBeenCalledTimes(1);
	});

	it("preserves transcription failures unrelated to missing speech", async () => {
		mocks.transcribe.mockResolvedValueOnce({
			id: "failed-transcript",
			status: "error",
			error: "Audio could not be decoded",
		});

		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");

		await expect(
			transcribeVideoWorkflow({
				videoId: "video-123",
				userId: "user-456",
				aiGenerationEnabled: false,
			}),
		).rejects.toThrow("Audio could not be decoded");
		expect(mocks.updates).toContainEqual({ transcriptionStatus: "ERROR" });
		expect(mocks.updates).not.toContainEqual({
			transcriptionStatus: "NO_AUDIO",
		});
	});

	it("never overwrites the original-timeline transcript of an edited video", async () => {
		state.editRows = [
			{
				sourceKey: "user-456/video-123/original.mp4",
				editSpec: {
					version: 1,
					sourceDuration: 12,
					keepRanges: [{ start: 0, end: 4 }],
				},
			},
		];

		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		await transcribeVideoWorkflow({
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		});

		const writtenKeys = mocks.putObject.mock.calls.map((call) => call[0]);
		expect(writtenKeys).toContain("user-456/video-123/transcription.vtt");
		expect(writtenKeys).not.toContain(
			"user-456/video-123/transcription.edit.v3.json",
		);
	});
});

describe("backfillEditTranscriptWorkflow", () => {
	beforeEach(() => {
		videoRow.transcriptionStatus = "COMPLETE";
		state.editRows = [];
		state.speakerLabels = false;
		state.claim = null;
		videoRow.metadata = {
			editTranscriptBackfill: {
				status: "processing",
				requestId: "request-1",
				requestedAt: "2026-07-30T00:00:00.000Z",
			},
		};
		mocks.transcribe.mockResolvedValue({
			...assemblyAIEditResponse,
			audio_duration: 4,
		});
		mocks.putObject.mockImplementation(() => pipeValue(undefined));
		mocks.deleteObject.mockImplementation(() => pipeValue(undefined));
		mocks.getInternalSignedObjectUrl.mockImplementation(() =>
			pipeValue("https://storage.test/object"),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				statusText: "OK",
				arrayBuffer: async () => new ArrayBuffer(8),
			})),
		);
	});

	it("transcribes the original media in the original timeline when edits exist", async () => {
		state.editRows = [
			{
				sourceKey: "user-456/video-123/original.mp4",
				editSpec: {
					version: 1,
					sourceDuration: 12,
					keepRanges: [{ start: 0, end: 4 }],
				},
			},
		];

		const { backfillEditTranscriptWorkflow } = await import(
			"@/workflows/transcribe"
		);
		const result = await backfillEditTranscriptWorkflow({
			videoId: "video-123",
			userId: "user-456",
			requestId: "request-1",
		});

		expect(result.success).toBe(true);
		expect(mocks.getInternalSignedObjectUrl.mock.calls[0]?.[0]).toBe(
			"user-456/video-123/original.mp4",
		);
		expect(mocks.transcribe).toHaveBeenCalledOnce();
		expect(mocks.submit).not.toHaveBeenCalled();
		expect(mocks.waitUntilReady).not.toHaveBeenCalled();
		expect(mocks.transcribe.mock.calls[0]?.[0]).not.toHaveProperty(
			"speaker_labels",
		);

		const { parseEditTranscript } = await import("@/lib/edit-transcript");
		const { decryptEditTranscriptObject } = await import(
			"@/lib/edit-transcript-storage"
		);
		const write = mocks.putObject.mock.calls.find(
			(call) => call[0] === "user-456/video-123/transcription.edit.v3.json",
		);
		const decrypted = decryptEditTranscriptObject(
			write?.[1] as string,
			"user-456",
			"video-123",
		);
		expect(parseEditTranscript(decrypted ?? "")).toMatchObject({
			durationMs: 12_000,
		});
		expect(mocks.deleteObject).not.toHaveBeenCalledWith(
			"user-456/video-123/transcription.edit.v3.status.json",
		);
	});

	it("does not run a backfill after its database claim is replaced", async () => {
		const { backfillEditTranscriptWorkflow } = await import(
			"@/workflows/transcribe"
		);
		const result = await backfillEditTranscriptWorkflow({
			videoId: "video-123",
			userId: "user-456",
			requestId: "expired-request",
		});

		expect(result.success).toBe(false);
		expect(mocks.transcribe).not.toHaveBeenCalled();
		expect(mocks.putObject).not.toHaveBeenCalledWith(
			"user-456/video-123/transcription.edit.v3.json",
			expect.anything(),
			expect.anything(),
		);
	});
});

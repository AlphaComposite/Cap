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
	probeVideo: vi.fn(),
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
	bucket: null as string | null,
	storageIntegrationId: null as string | null,
	duration: 4,
	createdAt: new Date(),
	settings: null as { disableTranscript: boolean } | null,
	source: { type: "webMP4" },
	isScreenshot: false,
	transcriptionStatus: "COMPLETE" as string | null,
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
	legacy: false,
	claimRead: null as null | (() => Promise<void>),
	afterValidation: null as null | (() => void),
	parentResult: undefined as unknown,
	writeResult: undefined as unknown,
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
				if (query.values.includes("legacy-transcript-submit")) {
					return [state.legacy ? [{ payload: { videoId: videoRow.id } }] : []];
				}
				const found = state.claim
					? [{ payload: structuredClone(state.claim) }]
					: [];
				const hook = state.claimRead;
				state.claimRead = null;
				await hook?.();
				return [found];
			}
			if (text.includes("FROM videos") && text.includes("FOR UPDATE")) {
				if (state.parentResult !== undefined) return state.parentResult;
				return [
					[
						{
							id: videoRow.id,
							ownerId: videoRow.ownerId,
							bucket: videoRow.bucket,
							storageIntegrationId: videoRow.storageIntegrationId,
							transcriptionStatus: videoRow.transcriptionStatus,
						},
					],
				];
			}
			if (text.includes("FROM videos v")) {
				return [
					[
						{
							videoId: videoRow.id,
							ownerId: videoRow.ownerId,
							transcriptionStatus: videoRow.transcriptionStatus,
							bucket: videoRow.bucket,
							storageIntegrationId: videoRow.storageIntegrationId,
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
				if (query.values.includes("legacy-transcript-submit"))
					state.legacy = true;
				else state.claim = JSON.parse(String(query.values[2]));
			}
			if (text.includes("UPDATE outbox")) {
				const payload = JSON.parse(String(query.values[0]));
				if (state.failTransition && payload.state === "submitting")
					throw new Error("submission marker write outage");
				if (state.failPersist && payload.transcriptId)
					throw new Error("accepted ID write outage");
				state.claim = payload;
			}
			if (text.includes("UPDATE videos")) {
				videoRow.transcriptionStatus = "PROCESSING";
				mocks.updates.push({ transcriptionStatus: "PROCESSING" });
			}
			return state.writeResult === undefined
				? [{ affectedRows: 1 }]
				: state.writeResult;
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
							where: async () => [
								{ video: structuredClone(videoRow), orgSettings: null },
							],
						}),
						where: async () => [videoRow],
					};
				},
			};
			return query;
		},
		update: () => ({
			set: (values: Record<string, unknown>) => {
				return {
					where: async (condition: unknown) => {
						const matches = (item: unknown): boolean => {
							if (!item || typeof item !== "object") return false;
							if ("conditions" in item && Array.isArray(item.conditions))
								return item.conditions.every(matches);
							if (
								"strings" in item &&
								Array.isArray(item.strings) &&
								item.strings
									.join("")
									.includes("'$.liveTranscript') IS NOT NULL")
							)
								return "liveTranscript" in videoRow.metadata;
							if (
								"strings" in item &&
								Array.isArray(item.strings) &&
								item.strings.join("").includes("<> 'COMPLETE'")
							)
								return videoRow.transcriptionStatus !== "COMPLETE";
							if (
								"field" in item &&
								"value" in item &&
								item.field === schemaMocks.videos.transcriptionStatus
							)
								return videoRow.transcriptionStatus === item.value;
							return true;
						};
						if (!matches(condition)) return [{ affectedRows: 0 }];
						mocks.updates.push(values);
						if ("transcriptionStatus" in values)
							videoRow.transcriptionStatus = values.transcriptionStatus as
								| string
								| null;
						if (values.transcriptionStatus === "PROCESSING") {
							const hook = state.afterValidation;
							state.afterValidation = null;
							hook?.();
						}
						return [{ affectedRows: 1 }];
					},
				};
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
		FatalError: runInNewContext(
			"(class FatalError extends Error { name = 'FatalError'; fatal = true; })",
		),
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
	probeVideoViaMediaServer: mocks.probeVideo,
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
	const { claim: reservation } = await reserveSpeakerLabelRecording(
		videoRow,
		"auto",
	);
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
					loseCompletion = false;
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
		vi.unstubAllEnvs();
		Reflect.deleteProperty(globalThis, Symbol.for("@workflow/world//cache"));
		Reflect.deleteProperty(
			globalThis,
			Symbol.for("@workflow/world//stubbedCache"),
		);
	});
	beforeEach(() => {
		mocks.updates.length = 0;
		videoRow.transcriptionStatus = "PROCESSING";
		videoRow.ownerId = "user-456";
		videoRow.bucket = null;
		videoRow.storageIntegrationId = null;
		videoRow.settings = null;
		state.editRows = [];
		state.speakerLabels = false;
		mocks.submit.mockReset();
		state.claim = null;
		state.legacy = false;
		state.claimRead = null;
		state.afterValidation = null;
		state.failPersist = false;
		state.parentResult = undefined;
		state.writeResult = undefined;
		state.failTransition = false;
		state.sourceSha256 = "a".repeat(64);
		state.sourceKey = "private/source/video-123/original";
		state.uploadPhase = "complete";
		state.queries = [];
		state.transaction = Promise.resolve();
		mocks.waitUntilReady.mockReset();
		mocks.probeVideo.mockReset();
		mocks.probeVideo.mockResolvedValue({ audioCodec: "aac" });
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

	it.each([false, true])(
		"marks a disabled transcript SKIPPED only while PROCESSING (completed late=%s)",
		async (completed) => {
			videoRow.settings = { disableTranscript: true };
			state.afterValidation = () => {
				if (completed) videoRow.transcriptionStatus = "COMPLETE";
			};
			const { transcribeVideoWorkflow } = await import(
				"@/workflows/transcribe"
			);
			await expect(
				transcribeVideoWorkflow({
					videoId: videoRow.id,
					userId: videoRow.ownerId,
					aiGenerationEnabled: true,
				}),
			).resolves.toMatchObject({ message: "Transcription disabled - skipped" });
			expect(videoRow.transcriptionStatus).toBe(
				completed ? "COMPLETE" : "SKIPPED",
			);
			expect(mocks.probeVideo).not.toHaveBeenCalled();
			expect(mocks.transcribe).not.toHaveBeenCalled();
			expect(mocks.submit).not.toHaveBeenCalled();
			expect(mocks.putObject).not.toHaveBeenCalled();
			expect(mocks.deleteObject).not.toHaveBeenCalled();
			expect(mocks.startAiGeneration).not.toHaveBeenCalled();
		},
	);

	it.each([
		"null extraction",
		"legacy no spoken audio",
		"labeled no spoken audio",
	])("preserves a completion after validation before late %s", async (path) => {
		state.speakerLabels = path === "labeled no spoken audio";
		if (path === "null extraction") {
			mocks.probeVideo.mockImplementationOnce(async () => {
				videoRow.transcriptionStatus = "COMPLETE";
				return { audioCodec: null };
			});
		} else {
			const provider = state.speakerLabels
				? mocks.waitUntilReady
				: mocks.transcribe;
			provider.mockImplementationOnce(async () => {
				videoRow.transcriptionStatus = "COMPLETE";
				return { id: "labeled-job", status: "error", error: "no spoken audio" };
			});
		}
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		await expect(
			transcribeVideoWorkflow({
				videoId: videoRow.id,
				userId: videoRow.ownerId,
				aiGenerationEnabled: true,
			}),
		).resolves.toMatchObject({ success: true });
		expect(videoRow.transcriptionStatus).toBe("COMPLETE");
		expect(mocks.updates).not.toContainEqual({
			transcriptionStatus: "NO_AUDIO",
		});
		expect(mocks.startAiGeneration).not.toHaveBeenCalled();
		expect(
			mocks.putObject.mock.calls.filter(([key]) =>
				String(key).includes("transcription"),
			),
		).toEqual([]);
		expect(
			mocks.deleteObject.mock.calls.every(([key]) =>
				String(key).endsWith(
					state.speakerLabels ? "audio-temp-speaker.mp3" : "audio-temp.mp3",
				),
			),
		).toBe(true);
	});

	it.each(["http", "network", "body"])(
		"the installed handler retries known pre-provider %s failure under the same reservation",
		async (failure) => {
			const runtime = await stepRuntime();
			const { submitSpeakerLabeledTranscription, transcribeVideoWorkflow } =
				await import("@/workflows/transcribe");
			const binding = await speakerSubmitBinding();
			const reservation = structuredClone(state.claim);
			vi.mocked(fetch).mockImplementationOnce(async () => {
				if (failure === "network") throw new Error("audio GET outage");
				if (failure === "http") return new Response(null, { status: 503 });
				const response = new Response("audio");
				vi.spyOn(response, "arrayBuffer").mockRejectedValueOnce(
					new Error("audio body outage"),
				);
				return response;
			});
			await runtime.register("submit", submitSpeakerLabeledTranscription, [
				"https://storage.test/audio",
				"auto",
				...binding,
			]);
			expect(await runtime.deliver("submit")).toEqual({ timeoutSeconds: 1 });
			expect(state.claim).toEqual(reservation);
			expect(mocks.submit).not.toHaveBeenCalled();
			await expect(
				transcribeVideoWorkflow({
					videoId: videoRow.id,
					userId: videoRow.ownerId,
					aiGenerationEnabled: false,
				}),
			).rejects.toThrow("outcome unknown");
			mocks.submit.mockImplementationOnce(async () => {
				expect(state.claim).toMatchObject({
					state: "submitting",
					token: binding[1],
				});
				return { id: "labeled-job" };
			});
			await runtime.deliver("submit");
			expect(await runtime.result("submit")).toBe("labeled-job");
			expect(mocks.submit).toHaveBeenCalledOnce();
			expect(mocks.transcribe).not.toHaveBeenCalled();
		},
	);

	it("leaves a known failed audio GET reserved and refuses a fresh workflow takeover", async () => {
		state.speakerLabels = true;
		const fetcher = vi.mocked(fetch).getMockImplementation();
		vi.mocked(fetch).mockImplementation(async (url, options) => {
			if (!options) {
				expect(state.claim?.state).toBe("reserved");
				return new Response(null, { status: 503 });
			}
			return fetcher ? fetcher(url, options) : new Response("audio");
		});
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const payload = {
			videoId: videoRow.id,
			userId: videoRow.ownerId,
			aiGenerationEnabled: false,
		};
		await expect(transcribeVideoWorkflow(payload)).rejects.toThrow(
			"audio is unavailable",
		);
		expect(state.claim?.state).toBe("reserved");
		const reservation = structuredClone(state.claim);
		state.speakerLabels = false;
		await expect(transcribeVideoWorkflow(payload)).rejects.toThrow(
			"outcome unknown",
		);
		expect(state.claim).toEqual(reservation);
		expect(mocks.submit).not.toHaveBeenCalled();
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it("exhausts pre-provider retries without consuming or releasing the reservation", async () => {
		const runtime = await stepRuntime();
		const { submitSpeakerLabeledTranscription } = await import(
			"@/workflows/transcribe"
		);
		const binding = await speakerSubmitBinding();
		const reservation = structuredClone(state.claim);
		vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
		await runtime.register("submit", submitSpeakerLabeledTranscription, [
			"https://storage.test/audio",
			"auto",
			...binding,
		]);
		for (let attempt = 0; attempt < 4; attempt++)
			await runtime.deliver("submit");
		expect(
			runtime.events.filter((event) => event.eventType === "step_retrying"),
		).toHaveLength(3);
		expect(runtime.events.at(-1)?.eventType).toBe("step_failed");
		expect(state.claim).toEqual(reservation);
		expect(mocks.submit).not.toHaveBeenCalled();
	});

	it.each(["completion", "source", "token", "owner"])(
		"revalidates %s after the audio body and before the first provider operation",
		async (change) => {
			const { submitSpeakerLabeledTranscription } = await import(
				"@/workflows/transcribe"
			);
			const binding = await speakerSubmitBinding();
			vi.mocked(fetch).mockImplementationOnce(async () => {
				const response = new Response("audio");
				vi.spyOn(response, "arrayBuffer").mockImplementationOnce(async () => {
					if (change === "completion")
						videoRow.transcriptionStatus = "COMPLETE";
					if (change === "source") state.sourceSha256 = "b".repeat(64);
					if (change === "token")
						state.claim = {
							...state.claim,
							token: "42f78038-50c7-4695-bef5-40842b24e047",
						};
					if (change === "owner")
						state.claim = { ...state.claim, ownerId: "another-owner" };
					return new ArrayBuffer(8);
				});
				return response;
			});
			await expect(
				submitSpeakerLabeledTranscription(
					"https://storage.test/audio",
					"auto",
					...binding,
				),
			).rejects.toThrow();
			expect(state.claim?.state).toBe("reserved");
			expect(mocks.submit).not.toHaveBeenCalled();
		},
	);

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

	it("a rejected retry cannot prevent the speaker owner from marking NO_AUDIO", async () => {
		state.speakerLabels = true;
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const payload = {
			videoId: videoRow.id,
			userId: videoRow.ownerId,
			aiGenerationEnabled: false,
		};
		vi.mocked(fetch).mockImplementationOnce(async () => {
			state.speakerLabels = false;
			await expect(transcribeVideoWorkflow(payload)).rejects.toThrow(
				"outcome unknown",
			);
			return new Response("audio");
		});
		mocks.waitUntilReady.mockResolvedValueOnce({
			id: "labeled-job",
			status: "error",
			error: "no spoken audio",
		});
		await expect(transcribeVideoWorkflow(payload)).resolves.toMatchObject({
			success: true,
		});
		expect(videoRow.transcriptionStatus).toBe("NO_AUDIO");
		expect(mocks.submit).toHaveBeenCalledOnce();
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it.each(["legacy", "backfill"])(
		"fences %s admission before its first paid POST against a selected run paused before reservation",
		async (path) => {
			state.speakerLabels = true;
			const { transcribeVideoWorkflow, backfillEditTranscriptWorkflow } =
				await import("@/workflows/transcribe");
			const payload = {
				videoId: "video-123",
				userId: "user-456",
				aiGenerationEnabled: false,
			};
			let resume = () => {};
			let observed = () => {};
			const paused = new Promise<void>((resolve) => {
				observed = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				resume = resolve;
			});
			state.claimRead = async () => {
				observed();
				await gate;
			};
			const selected = transcribeVideoWorkflow(payload).then(
				() => null,
				(error: unknown) => error,
			);
			await paused;
			state.speakerLabels = false;
			if (path === "backfill") videoRow.transcriptionStatus = "COMPLETE";
			let releaseAudio = () => {};
			let audioReady = () => {};
			const ready = new Promise<void>((resolve) => {
				audioReady = resolve;
			});
			const audioGate = new Promise<void>((resolve) => {
				releaseAudio = resolve;
			});
			const fetcher = vi.mocked(fetch).getMockImplementation();
			let blocked = false;
			vi.mocked(fetch).mockImplementation(async (url, options) => {
				if (!blocked && url === "https://storage.test/object" && !options) {
					blocked = true;
					if (path === "backfill") videoRow.transcriptionStatus = "PROCESSING";
					audioReady();
					await audioGate;
				}
				return fetcher ? fetcher(url, options) : new Response("audio");
			});
			const legacy =
				path === "backfill"
					? backfillEditTranscriptWorkflow({
							...payload,
							requestId: "request-1",
						})
					: transcribeVideoWorkflow(payload);
			await ready;
			state.speakerLabels = true;
			resume();
			const selectedError = await selected;
			releaseAudio();
			await legacy.catch(() => {});
			expect({
				legacy: mocks.transcribe.mock.calls.length,
				labeled: mocks.submit.mock.calls.length,
			}).toEqual({ legacy: 1, labeled: 0 });
			expect(selectedError).toMatchObject({
				message: expect.stringContaining("Legacy transcription"),
			});
		},
	);

	it.each(["new selection", "accepted resume"])(
		"does not reopen COMPLETE after a stale validation read: %s",
		async (path) => {
			state.speakerLabels = true;
			if (path === "accepted resume") {
				const { submitSpeakerLabeledTranscription } = await import(
					"@/workflows/transcribe"
				);
				await submitSpeakerLabeledTranscription(
					"https://storage.test/audio",
					"auto",
					...(await speakerSubmitBinding()),
				);
				mocks.submit.mockClear();
			}
			mocks.updates.length = 0;
			state.claimRead = async () => {
				videoRow.transcriptionStatus = "COMPLETE";
			};
			const { transcribeVideoWorkflow } = await import(
				"@/workflows/transcribe"
			);
			await transcribeVideoWorkflow({
				videoId: "video-123",
				userId: "user-456",
				aiGenerationEnabled: false,
			}).catch(() => {});
			expect(videoRow.transcriptionStatus).toBe("COMPLETE");
			expect(mocks.updates).not.toContainEqual({
				transcriptionStatus: "PROCESSING",
			});
			expect(mocks.submit).not.toHaveBeenCalled();
			expect(mocks.waitUntilReady).not.toHaveBeenCalled();
			expect(mocks.putObject).not.toHaveBeenCalled();
		},
	);

	it.each(["accepted", "submitting"])(
		"fails closed for contradictory durable %s state",
		async (status) => {
			const { submitSpeakerLabeledTranscription } = await import(
				"@/workflows/transcribe"
			);
			await submitSpeakerLabeledTranscription(
				"https://storage.test/audio",
				"auto",
				...(await speakerSubmitBinding()),
			);
			state.claim = {
				...state.claim,
				state: status,
				transcriptId: status === "submitting" ? "labeled-job" : undefined,
			};
			const { loadSpeakerLabelClaim } = await import(
				"@/lib/speaker-label-claim"
			);
			await expect(loadSpeakerLabelClaim("video-123")).rejects.toThrow(
				"requires reconciliation",
			);
		},
	);

	it.each(["legacy", "backfill"])(
		"holds a stale %s worker when the label reservation wins first",
		async (path) => {
			const { transcribeVideoWorkflow, backfillEditTranscriptWorkflow } =
				await import("@/workflows/transcribe");
			const payload = {
				videoId: "video-123",
				userId: "user-456",
				aiGenerationEnabled: false,
			};
			if (path === "backfill") videoRow.transcriptionStatus = "COMPLETE";
			let release = () => {};
			let observed = () => {};
			const ready = new Promise<void>((resolve) => {
				observed = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			vi.mocked(fetch).mockImplementationOnce(async () => {
				observed();
				await gate;
				return new Response("audio");
			});
			const stale = (
				path === "backfill"
					? backfillEditTranscriptWorkflow({
							...payload,
							requestId: "request-1",
						})
					: transcribeVideoWorkflow(payload)
			).catch(() => null);
			await ready;
			videoRow.transcriptionStatus = "PROCESSING";
			state.speakerLabels = true;
			vi.mocked(fetch).mockImplementationOnce(async () => {
				const key = mocks.getInternalSignedObjectUrl.mock.lastCall?.[0];
				state.speakerLabels = false;
				release();
				await stale;
				expect(videoRow.transcriptionStatus).toBe("PROCESSING");
				return mocks.deleteObject.mock.calls.some(
					([deleted]) => deleted === key,
				)
					? new Response(null, { status: 404 })
					: new Response("audio");
			});
			await transcribeVideoWorkflow(payload);
			expect(mocks.submit).toHaveBeenCalledOnce();
			expect(mocks.transcribe).not.toHaveBeenCalled();
			const audioKey = mocks.getInternalSignedObjectUrl.mock.lastCall?.[0];
			expect(
				mocks.deleteObject.mock.calls.filter(([key]) => key === audioKey),
			).toHaveLength(1);
		},
	);

	it("keeps legacy retry and backfill admission after a durable legacy marker, even if selection changes", async () => {
		const { transcribeVideoWorkflow, backfillEditTranscriptWorkflow } =
			await import("@/workflows/transcribe");
		const payload = {
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		};
		mocks.transcribe.mockRejectedValueOnce(new Error("supported legacy retry"));
		await expect(transcribeVideoWorkflow(payload)).rejects.toThrow(
			"supported legacy retry",
		);
		state.speakerLabels = true;
		await transcribeVideoWorkflow(payload);
		const { assertNoSpeakerLabelClaim, reserveSpeakerLabelRecording } =
			await import("@/lib/speaker-label-claim");
		await expect(
			assertNoSpeakerLabelClaim(videoRow.id),
		).resolves.toBeUndefined();
		await expect(
			reserveSpeakerLabelRecording(videoRow, "auto"),
		).rejects.toThrow("Legacy transcription");
		await expect(
			backfillEditTranscriptWorkflow({ ...payload, requestId: "request-1" }),
		).resolves.toEqual({ success: true });
		expect(mocks.transcribe).toHaveBeenCalledTimes(3);
		expect(mocks.submit).not.toHaveBeenCalled();
	});

	it("does not let a stale flag-off validator reopen completed labeled output", async () => {
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		const payload = {
			videoId: "video-123",
			userId: "user-456",
			aiGenerationEnabled: false,
		};
		state.claimRead = async () => {
			state.speakerLabels = true;
			await transcribeVideoWorkflow(payload);
			state.speakerLabels = false;
			mocks.updates.length = 0;
			mocks.putObject.mockClear();
		};
		await transcribeVideoWorkflow(payload).catch(() => {});
		expect(videoRow.transcriptionStatus).toBe("COMPLETE");
		expect(mocks.updates).toHaveLength(0);
		expect(mocks.putObject).not.toHaveBeenCalled();
		expect(mocks.transcribe).not.toHaveBeenCalled();
		expect(mocks.submit).toHaveBeenCalledOnce();
	});

	it("admits a SQL-null status but preserves a pre-enqueue PROCESSING claim", async () => {
		const { reserveSpeakerLabelRecording } = await import(
			"@/lib/speaker-label-claim"
		);
		videoRow.transcriptionStatus = null;
		await reserveSpeakerLabelRecording(videoRow, "auto");
		expect(videoRow.transcriptionStatus).toBe("PROCESSING");
		expect(
			state.queries.some((query) =>
				query.includes(
					"transcriptionStatus IS NULL OR transcriptionStatus <> 'COMPLETE'",
				),
			),
		).toBe(true);
		state.claim = null;
		mocks.updates.length = 0;
		await reserveSpeakerLabelRecording(videoRow, "auto");
		expect(mocks.updates).toHaveLength(0);
	});

	it.each([
		null,
		[[]],
		[[{ id: "wrong", transcriptionStatus: null }]],
		[
			[
				{ id: "video-123", transcriptionStatus: null },
				{ id: "video-123", transcriptionStatus: null },
			],
		],
	])("rejects inexact parent lock results %j", async (result) => {
		state.parentResult = result;
		const { reserveSpeakerLabelRecording, assertNoSpeakerLabelClaim } =
			await import("@/lib/speaker-label-claim");
		await expect(
			reserveSpeakerLabelRecording(videoRow, "auto"),
		).rejects.toThrow();
		await expect(assertNoSpeakerLabelClaim(videoRow.id)).rejects.toThrow();
		expect(state.claim).toBeNull();
		expect(state.legacy).toBe(false);
	});

	it.each([
		null,
		[],
		[{}],
		[{ affectedRows: 0 }],
		[{ affectedRows: 2 }],
		[{ affectedRows: "1" }],
	])("requires exactly one admission write %j", async (result) => {
		state.speakerLabels = true;
		state.writeResult = result;
		const { transcribeVideoWorkflow } = await import("@/workflows/transcribe");
		await expect(
			transcribeVideoWorkflow({
				videoId: "video-123",
				userId: "user-456",
				aiGenerationEnabled: false,
			}),
		).rejects.toThrow("durable write requires reconciliation");
		expect(mocks.submit).not.toHaveBeenCalled();
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it("refuses a stale submit after completion without a paid POST", async () => {
		const binding = await speakerSubmitBinding();
		videoRow.transcriptionStatus = "COMPLETE";
		const { submitSpeakerLabeledTranscription } = await import(
			"@/workflows/transcribe"
		);
		await expect(
			submitSpeakerLabeledTranscription(
				"https://storage.test/audio",
				"auto",
				...binding,
			),
		).rejects.toThrow("already completed");
		expect(mocks.submit).not.toHaveBeenCalled();
		expect(mocks.putObject).not.toHaveBeenCalled();
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
				query.includes("SELECT id, transcriptionStatus,") &&
				query.includes("FOR UPDATE"),
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

	it.each([false, true])(
		"keeps one private speaker audio key across an owner allowlist change (initially listed=%s)",
		async (listed) => {
			vi.stubEnv("CAP_INSTANT_FINISH_OWNERS", listed ? videoRow.ownerId : "");
			state.speakerLabels = true;
			mocks.deleteObject.mockImplementationOnce(() => {
				throw new Error("temporary cleanup outage");
			});
			const { transcribeVideoWorkflow } = await import(
				"@/workflows/transcribe"
			);
			const payload = {
				videoId: videoRow.id,
				userId: videoRow.ownerId,
				aiGenerationEnabled: false,
			};
			await transcribeVideoWorkflow(payload);
			const key = "private/source/video-123/audio-temp-speaker.mp3";

			vi.stubEnv("CAP_INSTANT_FINISH_OWNERS", listed ? "" : videoRow.ownerId);
			state.speakerLabels = false;
			await expect(transcribeVideoWorkflow(payload)).resolves.toMatchObject({
				message: "Speaker-labeled transcription already completed",
			});
			expect(mocks.deleteObject.mock.calls).toEqual([[key], [key]]);
			expect(
				mocks.putObject.mock.calls
					.map(([objectKey]) => objectKey)
					.filter((objectKey) => String(objectKey).endsWith(".mp3")),
			).toEqual([key]);
			expect(mocks.getInternalSignedObjectUrl.mock.calls).toEqual([
				[state.sourceKey],
				[key],
			]);
			expect(mocks.submit).toHaveBeenCalledOnce();
			expect(mocks.waitUntilReady).toHaveBeenCalledOnce();
			expect(mocks.transcribe).not.toHaveBeenCalled();
			expect(videoRow.transcriptionStatus).toBe("COMPLETE");
		},
	);

	it.each([false, true])(
		"cleans only bound speaker audio when resuming an accepted ID after a crash (bucket changed=%s)",
		async (changed) => {
			const { submitSpeakerLabeledTranscription, transcribeVideoWorkflow } =
				await import("@/workflows/transcribe");
			await submitSpeakerLabeledTranscription(
				"https://storage.test/audio",
				"auto",
				...(await speakerSubmitBinding()),
			);
			expect(mocks.deleteObject).not.toHaveBeenCalled();
			if (changed) videoRow.bucket = "other-bucket";
			const resumed = transcribeVideoWorkflow({
				videoId: videoRow.id,
				userId: videoRow.ownerId,
				aiGenerationEnabled: false,
			});
			if (changed) {
				await expect(resumed).rejects.toThrow("recording storage changed");
				expect(mocks.deleteObject).not.toHaveBeenCalled();
				expect(mocks.waitUntilReady).not.toHaveBeenCalled();
				return;
			}
			await resumed;
			expect(videoRow.transcriptionStatus).toBe("COMPLETE");
			expect(mocks.deleteObject).toHaveBeenCalledExactlyOnceWith(
				"private/source/video-123/audio-temp-speaker.mp3",
			);
			expect(mocks.getInternalSignedObjectUrl).not.toHaveBeenCalled();
			expect(mocks.submit).toHaveBeenCalledOnce();
			expect(mocks.transcribe).not.toHaveBeenCalled();
		},
	);

	it.each(["ownerId", "bucket", "storageIntegrationId"] as const)(
		"does not reopen an accepted ID when %s changes before admission locks the row",
		async (field) => {
			const { submitSpeakerLabeledTranscription, transcribeVideoWorkflow } =
				await import("@/workflows/transcribe");
			await submitSpeakerLabeledTranscription(
				"https://storage.test/audio",
				"auto",
				...(await speakerSubmitBinding()),
			);
			videoRow.transcriptionStatus = "ERROR";
			state.claimRead = async () => {
				videoRow[field] = "changed";
			};
			await expect(
				transcribeVideoWorkflow({
					videoId: videoRow.id,
					userId: "user-456",
					aiGenerationEnabled: false,
				}),
			).rejects.toThrow("recording storage changed");
			expect(videoRow.transcriptionStatus).toBe("ERROR");
			expect(mocks.updates).toHaveLength(0);
			expect(mocks.deleteObject).not.toHaveBeenCalled();
			expect(mocks.waitUntilReady).not.toHaveBeenCalled();
			expect(mocks.putObject).not.toHaveBeenCalled();
			expect(mocks.submit).toHaveBeenCalledOnce();
			expect(mocks.transcribe).not.toHaveBeenCalled();
		},
	);

	it.each([
		"complete",
		"completed during admission",
		"moved bucket",
		"wrong owner",
	])(
		"recovers only bound speaker audio after completion: %s",
		async (scenario) => {
			const { submitSpeakerLabeledTranscription, transcribeVideoWorkflow } =
				await import("@/workflows/transcribe");
			await submitSpeakerLabeledTranscription(
				"https://storage.test/audio",
				"auto",
				...(await speakerSubmitBinding()),
			);
			if (scenario === "completed during admission") {
				state.claimRead = async () => {
					videoRow.transcriptionStatus = "COMPLETE";
				};
			} else {
				videoRow.transcriptionStatus = "COMPLETE";
			}
			if (scenario === "moved bucket") videoRow.bucket = "other-bucket";
			const resumed = transcribeVideoWorkflow({
				videoId: videoRow.id,
				userId: scenario === "wrong owner" ? "other-user" : videoRow.ownerId,
				aiGenerationEnabled: true,
			});
			if (scenario === "moved bucket" || scenario === "wrong owner") {
				await expect(resumed).rejects.toThrow("changed");
				expect(mocks.deleteObject).not.toHaveBeenCalled();
			} else {
				await expect(resumed).resolves.toMatchObject({ success: true });
				expect(mocks.deleteObject).toHaveBeenCalledExactlyOnceWith(
					"private/source/video-123/audio-temp-speaker.mp3",
				);
			}
			expect(videoRow.transcriptionStatus).toBe("COMPLETE");
			expect(mocks.updates).toHaveLength(0);
			expect(mocks.getInternalSignedObjectUrl).not.toHaveBeenCalled();
			expect(mocks.waitUntilReady).not.toHaveBeenCalled();
			expect(mocks.putObject).not.toHaveBeenCalled();
			expect(mocks.startAiGeneration).not.toHaveBeenCalled();
			expect(mocks.submit).toHaveBeenCalledOnce();
			expect(mocks.transcribe).not.toHaveBeenCalled();
		},
	);

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
		videoRow.transcriptionStatus = "ERROR";
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
		videoRow.transcriptionStatus = "ERROR";
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
		videoRow.transcriptionStatus = "PROCESSING";
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
		expect(submitSpeakerLabeledTranscription.maxRetries).toBe(3);
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

	it.each([
		"upload response lost",
		"acceptance response lost",
		"accepted ID write outage",
	])(
		"the installed step handler never re-executes ambiguous submit on redelivery: %s",
		async (failure) => {
			const runtime = await stepRuntime();
			const { submitSpeakerLabeledTranscription } = await import(
				"@/workflows/transcribe"
			);
			if (failure === "accepted ID write outage") state.failPersist = true;
			else mocks.submit.mockRejectedValueOnce(new Error(failure));
			await runtime.register("submit", submitSpeakerLabeledTranscription, [
				"https://storage.test/audio",
				"auto",
				...(await speakerSubmitBinding()),
			]);
			await runtime.deliver("submit");
			await runtime.deliver("submit");
			expect(mocks.submit).toHaveBeenCalledOnce();
			expect(state.claim?.state).toBe("submitting");
			expect(mocks.waitUntilReady).not.toHaveBeenCalled();
			expect(mocks.transcribe).not.toHaveBeenCalled();
			expect(runtime.events.map((event) => event.eventType)).not.toContain(
				"step_retrying",
			);
			expect(runtime.events.map((event) => event.eventType)).toContain(
				"step_failed",
			);
		},
	);

	it("the installed step handler reuses the durable accepted ID after step completion persistence fails", async () => {
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
		vi.mocked(fetch).mockRejectedValue(
			new Error("audio is no longer available"),
		);
		await runtime.deliver("submit");
		expect(await runtime.result("submit")).toBe("labeled-job");
		expect(mocks.submit).toHaveBeenCalledOnce();
		expect(mocks.waitUntilReady).not.toHaveBeenCalled();
		expect(runtime.events.map((event) => event.eventType)).toEqual([
			"step_started",
			"step_started",
			"step_completed",
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
		state.parentResult = undefined;
		state.writeResult = undefined;
		state.legacy = false;
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

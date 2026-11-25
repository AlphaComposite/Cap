import { execFile } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	assertNoSpeakerLabelClaim,
	isSpeakerLabelCanary,
} from "@/lib/speaker-label-claim";

const env = vi.hoisted(() => ({
	file: undefined as string | undefined,
	staticSelection: undefined as string | undefined,
	execute: vi.fn(),
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		CAP_TRANSCRIPT_SPEAKER_LABELS_CANARY: env.staticSelection,
		CAP_TRANSCRIPT_SPEAKER_LABELS_CANARY_FILE: env.file,
	}),
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		transaction: (work: (tx: { execute: typeof env.execute }) => unknown) =>
			work({ execute: env.execute }),
	}),
}));
vi.mock("workflow", () => ({ FatalError: class extends Error {} }));
vi.mock("drizzle-orm", () => ({
	sql: (strings: string[], ...values: unknown[]) => ({ strings, values }),
}));

const ownerId = "000000000000001";
const videoId = "000000000000002";
const other = "000000000000003";
let directory: string;
let file: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "cap-selector-"));
	file = join(directory, "selection");
	env.file = file;
	env.staticSelection = undefined;
	env.execute.mockReset();
});
afterEach(() => {
	rmSync(directory, { recursive: true });
	vi.useRealTimers();
});

it("sees a late bind for only the exact new owner and recording, until expiry", () => {
	vi.useFakeTimers();
	const cutoff = Date.now();
	const video = { id: videoId, ownerId, createdAt: new Date() };
	expect(isSpeakerLabelCanary(video)).toBe(false);
	writeFileSync(file, `${ownerId}/${videoId}/${cutoff}`);
	expect(isSpeakerLabelCanary(video)).toBe(true);
	expect(isSpeakerLabelCanary({ ...video, id: other })).toBe(false);
	expect(isSpeakerLabelCanary({ ...video, ownerId: other })).toBe(false);
	expect(
		isSpeakerLabelCanary({ ...video, createdAt: new Date(cutoff - 1) }),
	).toBe(false);
	expect(
		isSpeakerLabelCanary({ ...video, createdAt: new Date(cutoff + 1) }),
	).toBe(false);
	vi.setSystemTime(cutoff + 3_600_001);
	expect(isSpeakerLabelCanary(video)).toBe(false);
});

it("fences legacy admission for the bound ID but leaves other IDs and existing legacy admissions alone", async () => {
	let legacy = false;
	env.execute.mockImplementation(
		async (query: { strings: string[]; values: string[] }) => {
			const text = query.strings.join("?");
			if (text.includes("FROM videos"))
				return [[{ id: query.values[0], transcriptionStatus: null }]];
			if (text.includes("FROM outbox"))
				return [
					legacy && query.values.includes("legacy-transcript-submit")
						? [{}]
						: [],
				];
			if (text.includes("INSERT INTO outbox")) return [{ affectedRows: 1 }];
			throw new Error("Unrecognized query");
		},
	);
	await expect(assertNoSpeakerLabelClaim(other)).resolves.toBeUndefined();
	writeFileSync(file, `${ownerId}/${videoId}/${Date.now()}`);
	await expect(assertNoSpeakerLabelClaim(videoId)).rejects.toThrow(
		"no fallback submission",
	);
	await expect(assertNoSpeakerLabelClaim(other)).resolves.toBeUndefined();
	legacy = true;
	await expect(assertNoSpeakerLabelClaim(videoId)).resolves.toBeUndefined();
});

it("fails closed on malformed, unreadable or conflicting configuration", () => {
	const video = { id: videoId, ownerId, createdAt: new Date() };
	writeFileSync(file, `${ownerId}/*/${Date.now()}`);
	expect(() => isSpeakerLabelCanary(video)).toThrow(
		"Invalid speaker-label selector",
	);
	env.file = directory;
	expect(() => isSpeakerLabelCanary(video)).toThrow(
		"Cannot read speaker-label selector",
	);
	env.file = file;
	env.staticSelection = `${ownerId}/${videoId}/${Date.now()}`;
	expect(() => isSpeakerLabelCanary(video)).toThrow(
		"Conflicting speaker-label selectors",
	);
});

it("rejects a missing selector directory or dangling selector instead of treating it as unbound", () => {
	const video = { id: videoId, ownerId, createdAt: new Date() };
	env.file = join(directory, "missing-mount", "selection");
	expect(() => isSpeakerLabelCanary(video)).toThrow(
		"Cannot read speaker-label selector",
	);
	env.file = file;
	symlinkSync(join(directory, "missing-target"), file);
	expect(() => isSpeakerLabelCanary(video)).toThrow(
		"Cannot read speaker-label selector",
	);
});

it("publishes one complete binding even when two operators bind concurrently", async () => {
	const cutoff = String(Date.now());
	const script = fileURLToPath(
		new URL(
			"../../../../scripts/bind-speaker-label-canary.sh",
			import.meta.url,
		),
	);
	const run = promisify(execFile);
	const bind = (id: string, time = cutoff) =>
		run("bash", [script, file, ownerId, id, time]);
	await expect(bind("*")).rejects.toThrow();
	await expect(
		bind(videoId, String(Number(cutoff) + 60_000)),
	).rejects.toThrow();
	await expect(
		bind(videoId, String(Number(cutoff) - 3_600_001)),
	).rejects.toThrow();
	const contenders = [videoId, other];
	const results = await Promise.allSettled(contenders.map((id) => bind(id)));
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	const winner =
		contenders[results.findIndex((result) => result.status === "fulfilled")];
	expect(readFileSync(file, "utf8")).toBe(`${ownerId}/${winner}/${cutoff}`);
	await expect(bind(other)).rejects.toThrow();
	expect(readFileSync(file, "utf8")).toBe(`${ownerId}/${winner}/${cutoff}`);
});

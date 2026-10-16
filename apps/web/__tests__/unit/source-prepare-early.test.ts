import * as schema from "@cap/database/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainSourcePrepare } from "@/lib/source-prepare-worker";

const runtime = vi.hoisted(() => ({
	prepare: vi.fn(),
	publish: vi.fn(),
	copy: vi.fn(),
	exists: vi.fn(),
	sha256: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/revision-publication-origin", () => ({
	prepareSourceOnEditorOpen: runtime.prepare,
}));
vi.mock("@/lib/instant-finish-source-relocate", () => ({
	runtimeObjectStore: () => runtime,
	reconcileOriginReadPolicy: async () => true,
}));
vi.mock("@/lib/revision-publication", () => ({
	publishInstantFinishRevision: runtime.publish,
}));

const VIDEO = "videoearly01",
	OWNER = "ownerearly01";
const ORIGINAL = `${OWNER}/${VIDEO}/result.mp4`,
	PRIVATE = `private/source/${VIDEO}/original`;
const SHA = "a".repeat(64);
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function fixture() {
	const rows = new Map<unknown, any[]>([
		[schema.videos, [{ id: VIDEO, ownerId: OWNER, duration: 2 }]],
		[
			schema.revisionOutbox,
			[
				{
					id: 1,
					videoId: VIDEO,
					job: "source-prepare",
					payload: {
						videoId: VIDEO,
						ownerId: OWNER,
						sourceObjectKey: ORIGINAL,
						stableKey: PRIVATE,
						attempts: 0,
					},
				},
			],
		],
		...[
			schema.sourceObject,
			schema.sourceRelocation,
			schema.videoPublication,
			schema.editIntent,
			schema.editRevision,
			schema.videoEdits,
		].map((table) => [table, []] as [unknown, any[]]),
	]);
	const identityWrites: any[] = [];
	const query = (values: any[]) => {
		const promise = Promise.resolve(values) as any;
		for (const name of ["where", "for", "orderBy", "limit"])
			promise[name] = () => promise;
		return promise;
	};
	const app: any = {
		select: () => ({ from: (table: unknown) => query(rows.get(table) ?? []) }),
		insert: (table: unknown) => ({
			values: async (value: any) => {
				rows.get(table)!.push(value);
			},
		}),
		update: (table: unknown) => ({
			set: (value: any) => ({
				where: async () => {
					if (table === schema.sourceObject && value.a1Digest)
						identityWrites.push(value);
					Object.assign(rows.get(table)![0], value);
				},
			}),
		}),
		delete: (table: unknown) => ({ where: async () => rows.set(table, []) }),
		transaction: async (fn: any) => fn(app),
	};
	return { app, rows, identityWrites };
}

beforeEach(() => {
	vi.stubEnv("CAP_INSTANT_FINISH_OWNERS", OWNER);
	vi.stubEnv("ORIGIN_READ_MODE", "presign");
	runtime.exists
		.mockReset()
		.mockImplementation(async (key: string) => key === ORIGINAL);
	runtime.copy.mockReset().mockResolvedValue(undefined);
	runtime.sha256.mockReset().mockResolvedValue(SHA);
	runtime.prepare.mockReset().mockImplementation(async ({ sourceKey }) => ({
		sourceKey,
		sha256: SHA,
		codec: "h264",
		timebase: "1/90000",
		frameMode: "cfr",
		a1Digest: "b".repeat(64),
		indexId: "index-early",
		warmExpiresAt: new Date(Date.now() + 600000).toISOString(),
	}));
	// Stop after observing the real publication input; no relocation/storage effects in this unit fixture.
	runtime.publish.mockReset().mockRejectedValue(new Error("publication seam"));
});
afterEach(() => vi.unstubAllEnvs());

describe("early source prepare joins verified copy before identity", () => {
	it("starts origin before stable copy resolves, writes only after both, and publishes private binding", async () => {
		const f = fixture(),
			copy = deferred<void>();
		runtime.copy.mockReturnValue(copy.promise);
		const run = drainSourcePrepare(f.app, {});
		try {
			await vi.waitFor(() =>
				expect(runtime.prepare).toHaveBeenCalledWith({
					videoId: VIDEO,
					sourceKey: ORIGINAL,
				}),
			);
			expect(f.rows.get(schema.sourceObject)).toEqual([]);
			expect(f.identityWrites).toEqual([]);
			expect(runtime.publish).not.toHaveBeenCalled();
		} finally {
			copy.resolve();
			await run;
		}
		expect(f.identityWrites).toHaveLength(1);
		expect(runtime.publish.mock.calls[0]?.[1].baselineIdentity).toMatchObject({
			key: PRIVATE,
			sha256: SHA,
		});
		expect(f.rows.get(schema.sourceRelocation)?.[0].state).toBe("COPIED");
	});

	it.each(["sha mismatch", "copy failure", "origin failure"])(
		"%s writes no prepared identity and publishes nothing",
		async (failure) => {
			const f = fixture(),
				copy = deferred<void>(),
				prepare = deferred<any>();
			runtime.copy.mockReturnValue(copy.promise);
			runtime.prepare.mockReturnValue(prepare.promise);
			const run = drainSourcePrepare(f.app, {});
			try {
				await vi.waitFor(() =>
					expect(runtime.prepare).toHaveBeenCalledWith({
						videoId: VIDEO,
						sourceKey: ORIGINAL,
					}),
				);
				expect(f.identityWrites).toEqual([]);
			} finally {
				if (failure === "copy failure") copy.reject(new Error("copy failed"));
				else copy.resolve();
				if (failure === "origin failure")
					prepare.reject(new Error("origin failed"));
				else
					prepare.resolve({
						sourceKey: ORIGINAL,
						sha256: failure === "sha mismatch" ? "c".repeat(64) : SHA,
						codec: "h264",
						timebase: "1/90000",
						frameMode: "cfr",
						a1Digest: "b".repeat(64),
						indexId: "index-early",
						warmExpiresAt: new Date(Date.now() + 600000).toISOString(),
					});
				await run;
			}
			expect(f.identityWrites).toEqual([]);
			expect(runtime.publish).not.toHaveBeenCalled();
			expect(f.rows.get(schema.revisionOutbox)?.[0].payload.attempts).toBe(1);
		},
	);

	it("reuses private prepare for COPIED resumes and never reopens the original", async () => {
		// Allowed fresh control gives RED against the serial implementation too.
		const fresh = fixture();
		await drainSourcePrepare(fresh.app, {});
		expect(runtime.prepare).toHaveBeenLastCalledWith({
			videoId: VIDEO,
			sourceKey: ORIGINAL,
		});
		const f = fixture();
		f.rows
			.get(schema.sourceObject)!
			.push({
				videoId: VIDEO,
				liveKey: ORIGINAL,
				sha256: SHA,
				relocationState: "LIVE",
			});
		f.rows
			.get(schema.sourceRelocation)!
			.push({
				videoId: VIDEO,
				oldKey: ORIGINAL,
				newKey: PRIVATE,
				sha256: SHA,
				state: "COPIED",
			});
		await drainSourcePrepare(f.app, {});
		expect(runtime.prepare).toHaveBeenLastCalledWith({
			videoId: VIDEO,
			sourceKey: PRIVATE,
		});
		expect(f.identityWrites).toHaveLength(1);
	});
});

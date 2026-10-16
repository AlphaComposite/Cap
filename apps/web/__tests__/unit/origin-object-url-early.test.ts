import * as schema from "@cap/database/schema";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/internal/origin/object-url/route";
import { recordedOriginReadKeys } from "@/lib/instant-finish-source-relocate";
import {
	ORIGIN_SERVICE_HEADER,
	signInternalServiceRequest,
} from "@/lib/revision-media-token";

const state = vi.hoisted(() => ({
	select: vi.fn(),
	get: vi.fn(),
	head: vi.fn(),
	bucket: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({ db: () => ({ select: state.select }) }));
vi.mock("@cap/web-backend", () => ({
	S3Buckets: { getBucketAccess: state.bucket },
}));
vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));
const VIDEO = "videourlearly01",
	OWNER = "ownerurlearly01",
	KEY = `${OWNER}/${VIDEO}/result.mp4`;
const path = "/api/internal/origin/object-url";
let sources: any[], stages: any[], jobs: any[], owners: any[];
function request(key: unknown = KEY, prepareVideoId: unknown = VIDEO) {
	const body = JSON.stringify({ key, prepareVideoId });
	return new Request(`http://web${path}`, {
		method: "POST",
		body,
		headers: {
			[ORIGIN_SERVICE_HEADER]: signInternalServiceRequest({
				method: "POST",
				path,
				body,
				audience: "web-object-url",
			}),
		},
	});
}
async function allowedControl() {
	expect((await POST(request())).status).toBe(200);
	state.get.mockClear();
	state.head.mockClear();
}
async function denied(key: unknown = KEY, video: unknown = VIDEO) {
	expect((await POST(request(key, video))).status).toBe(403);
	expect(state.get).not.toHaveBeenCalled();
	expect(state.head).not.toHaveBeenCalled();
}
beforeEach(() => {
	vi.stubEnv(
		"REVISION_ORIGIN_SERVICE_SECRET",
		"early-object-url-unit-secret".repeat(2),
	);
	sources = [];
	stages = [];
	owners = [{ id: VIDEO, ownerId: OWNER }];
	jobs = [
		{
			videoId: VIDEO,
			job: "source-prepare",
			payload: {
				videoId: VIDEO,
				ownerId: OWNER,
				sourceObjectKey: KEY,
				leaseToken: "lease-early",
				leaseUntilMs: Date.now() + 600000,
			},
		},
	];
	state.select.mockReset().mockImplementation(() => ({
		from: (table: unknown) => {
			const rows =
				table === schema.sourceObject
					? sources
					: table === schema.sourceRelocation
						? stages
						: table === schema.videos
							? owners
							: table === schema.revisionOutbox
								? jobs
								: [];
			const result = Promise.resolve(rows) as any;
			result.where = () => result;
			return result;
		},
	}));
	state.get.mockReset().mockReturnValue(Effect.succeed("http://storage/get"));
	state.head.mockReset().mockReturnValue(Effect.succeed("http://storage/head"));
	state.bucket.mockReset().mockReturnValue(
		Effect.succeed([
			{
				getInternalSignedObjectUrl: state.get,
				getInternalSignedHeadUrl: state.head,
			},
		]),
	);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("original source-prepare per-key URLs", () => {
	it("allows only own exact fresh/LIVE original with signed prepare scope, never the direct-policy list", async () => {
		await allowedControl();
		sources.push({
			videoId: VIDEO,
			liveKey: KEY,
			sha256: "a".repeat(64),
			relocationState: "LIVE",
		});
		await allowedControl();
		expect(
			await recordedOriginReadKeys({ select: state.select } as never),
		).not.toContain(KEY);
		await denied(KEY, null);
	});
	it("rejects other videos, prefixes, traversal, wildcards and nonmatching keys", async () => {
		await allowedControl();
		for (const key of [
			`${OWNER}/another/result.mp4`,
			`other/${VIDEO}/result.mp4`,
			`${OWNER}/${VIDEO}/`,
			`${OWNER}/${VIDEO}/*`,
			`${OWNER}/${VIDEO}/nested/result.mp4`,
			`${OWNER}/${VIDEO}/../result.mp4`,
			`${OWNER}/${VIDEO}/result.MP4`,
			`${KEY}?query=1`,
			`https://storage/${KEY}`,
			`${KEY}/extra`,
			null,
		])
			await denied(key);
		for (const video of ["another", "*", "../" + VIDEO, null])
			await denied(KEY, video);
	});
	it("revokes original URLs after any journalled stage or non-LIVE source, even before pointer relocation", async () => {
		await allowedControl();
		for (const state of ["COPIED", "POINTER", "DELETED", "PURGED"]) {
			stages = [
				{
					videoId: VIDEO,
					oldKey: KEY,
					newKey: `private/source/${VIDEO}/original`,
					state,
				},
			];
			await denied();
		}
		stages = [];
		for (const relocationState of ["COPIED", "POINTER", "PURGED", "live", ""]) {
			sources = [{ videoId: VIDEO, liveKey: KEY, relocationState }];
			await denied();
		}
		sources = [
			{
				videoId: VIDEO,
				liveKey: `private/source/${VIDEO}/original`,
				relocationState: "LIVE",
			},
		];
		await denied();
	});
	it("requires current owner and exact active leased job; finished/exhausted/peaks jobs grant nothing", async () => {
		await allowedControl();
		const original = structuredClone(jobs[0]);
		for (const [field, value] of [
			["videoId", "other"],
			["ownerId", "other"],
			["sourceObjectKey", KEY + "/other"],
			["leaseToken", ""],
			["leaseToken", null],
			["leaseUntilMs", 0],
			["leaseUntilMs", "99999999999999"],
			["finished", true],
			["exhausted", true],
			["peaksOnly", true],
		] as const) {
			jobs = [structuredClone(original)];
			jobs[0].payload[field] = value;
			await denied();
		}
		for (const [field, value] of [
			["videoId", "other"],
			["job", "prepare"],
		]) {
			jobs = [{ ...structuredClone(original), [field]: value }];
			await denied();
		}
		jobs = [];
		await denied();
		jobs = [original];
		owners = [];
		await denied();
		owners = [{ id: VIDEO, ownerId: "newowner" }];
		await denied();
	});
});

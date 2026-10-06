import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { db } from "@cap/database";
import {
	sourceObject,
	sourceRelocation,
	videoEdits,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { and, eq } from "drizzle-orm";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import { RevisionPublicationError } from "@/lib/revision-publication-metadata";
import {
	assertFinishInventoryClear,
	continueRelocation,
	isFinishInventoryExempt,
	type ObjectStore,
	type RelocationJournal,
	type RelocationRow,
	type RelocationState,
	relocateOwnerVideo,
} from "@/lib/source-relocation";
import { createS3Store } from "../scripts/instant-finish-relocate";

type Database = ReturnType<typeof db>;

function mapRow(row: {
	id: number;
	videoId: string;
	revisionId: string;
	oldKey: string;
	newKey: string;
	sha256: string;
	state: string;
	createdAt: Date | string;
}): RelocationRow {
	return {
		id: Number(row.id),
		videoId: row.videoId,
		revisionId: row.revisionId,
		oldKey: row.oldKey,
		newKey: row.newKey,
		sha256: row.sha256,
		state: row.state as RelocationState,
		createdAt:
			row.createdAt instanceof Date
				? row.createdAt.toISOString()
				: String(row.createdAt),
	};
}

export function drizzleRelocationJournal(app: Database): RelocationJournal {
	return {
		async insertIntent(row) {
			await app.insert(sourceRelocation).values({
				videoId: row.videoId as never,
				revisionId: row.revisionId,
				oldKey: row.oldKey,
				newKey: row.newKey,
				sha256: row.sha256,
				state: row.state,
				createdAt: new Date(),
			});
			const [stored] = await app
				.select()
				.from(sourceRelocation)
				.where(
					and(
						eq(sourceRelocation.videoId, row.videoId as never),
						eq(sourceRelocation.oldKey, row.oldKey),
						eq(sourceRelocation.newKey, row.newKey),
					),
				);
			if (!stored) throw new Error("relocation intent was not recorded");
			return mapRow(stored);
		},
		async mark(id, state, sha256) {
			await app
				.update(sourceRelocation)
				.set({ state, ...(sha256 ? { sha256 } : {}) })
				.where(eq(sourceRelocation.id, id));
		},
		async setLiveKey(videoId, liveKey, sha256, relocationState) {
			await app
				.insert(sourceObject)
				.values({
					videoId: videoId as never,
					liveKey,
					sha256,
					relocationState,
				})
				.onDuplicateKeyUpdate({
					set: { liveKey, sha256, relocationState },
				});
		},
		async getLiveKey(videoId) {
			const [row] = await app
				.select({ liveKey: sourceObject.liveKey })
				.from(sourceObject)
				.where(eq(sourceObject.videoId, videoId as never));
			return row?.liveKey ?? null;
		},
		async listOpen() {
			const rows = await app.select().from(sourceRelocation);
			return rows
				.filter((row) =>
					["INTENT", "COPIED", "POINTER", "DELETED"].includes(row.state),
				)
				.map(mapRow);
		},
		async listForVideo(videoId) {
			const rows = await app
				.select()
				.from(sourceRelocation)
				.where(eq(sourceRelocation.videoId, videoId as never));
			return rows.map(mapRow);
		},
		async get(id) {
			const [row] = await app
				.select()
				.from(sourceRelocation)
				.where(eq(sourceRelocation.id, id));
			return row ? mapRow(row) : null;
		},
	};
}

export function runtimeObjectStore(): ObjectStore {
	const env = serverEnv();
	const client = new S3Client({
		region: env.CAP_AWS_REGION,
		endpoint: env.S3_INTERNAL_ENDPOINT,
		forcePathStyle: env.S3_PATH_STYLE,
		credentials: {
			accessKeyId: env.CAP_AWS_ACCESS_KEY ?? "",
			secretAccessKey: env.CAP_AWS_SECRET_KEY ?? "",
		},
	});
	return createS3Store(client, env.CAP_AWS_BUCKET);
}

export async function relocateFlaggedSource(input: {
	videoId: string;
	ownerId: string;
	sourceKey: string;
	database?: Database;
	store?: ObjectStore;
}): Promise<{ liveKey: string; sha256: string }> {
	const app = input.database ?? db();
	const [upload] = await app
		.select({ rawFileKey: videoUploads.rawFileKey })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, input.videoId as never));
	const [edit] = await app
		.select({ sourceKey: videoEdits.sourceKey })
		.from(videoEdits)
		.where(eq(videoEdits.videoId, input.videoId as never));
	const prefix = `${input.ownerId}/${input.videoId}/`;
	let store = input.store;
	if (!store) {
		try {
			store = runtimeObjectStore();
		} catch (error) {
			throw new RevisionPublicationError(
				409,
				error instanceof Error
					? error.message
					: "Finish refused until source relocation is PURGED and liveKey is the relocated key",
			);
		}
	}
	const proof = await relocateOwnerVideo({
		ownerId: input.ownerId,
		videoId: input.videoId,
		store,
		journal: drizzleRelocationJournal(app),
		sourceKey: edit?.sourceKey ?? input.sourceKey,
		rawFileKey: upload?.rawFileKey ?? `${prefix}raw-upload.mp4`,
		outputKey: `${prefix}.recording/outputs/result.mp4`,
		referencedKeys: [input.sourceKey, edit?.sourceKey, upload?.rawFileKey],
	});
	if (!proof.liveKey || !proof.liveKeyPrivate) {
		throw new RevisionPublicationError(
			409,
			"Finish refused until source relocation is PURGED and liveKey is the relocated key",
		);
	}
	const [live] = await app
		.select({ sha256: sourceObject.sha256, liveKey: sourceObject.liveKey })
		.from(sourceObject)
		.where(eq(sourceObject.videoId, input.videoId as never));
	if (live?.liveKey !== proof.liveKey) {
		throw new RevisionPublicationError(
			409,
			"Finish refused until source relocation is PURGED and liveKey is the relocated key",
		);
	}
	return { liveKey: proof.liveKey, sha256: live.sha256 };
}

export async function completePreparedSourceInventory(
	app: Database,
	videoId: string,
	store: ObjectStore = runtimeObjectStore(),
): Promise<void> {
	const [video] = await app
		.select({ ownerId: videos.ownerId })
		.from(videos)
		.where(eq(videos.id, videoId as never));
	const [source] = await app
		.select()
		.from(sourceObject)
		.where(eq(sourceObject.videoId, videoId as never));
	if (
		!video ||
		!source ||
		!isInstantFinishEnabledForOwner(video.ownerId) ||
		source.relocationState !== "PURGED" ||
		!source.liveKey.startsWith(`private/source/${videoId}/`) ||
		!source.a1Digest ||
		!source.indexId ||
		!store.list
	)
		throw new Error("prepared original is not ready for inventory completion");
	const list = store.list.bind(store);
	const prefix = `${video.ownerId}/${videoId}/`;
	const journal = drizzleRelocationJournal(app);
	const rows = await journal.listForVideo(videoId);
	if (
		!rows.some(
			(row) =>
				row.newKey === source.liveKey &&
				row.sha256 === source.sha256 &&
				row.state === "PURGED",
		)
	)
		throw new Error("prepared original purge proof is missing");
	const listed = await store.list(prefix);
	if (
		listed.some(
			(key) =>
				!isFinishInventoryExempt(key, prefix) && key.includes("/source/"),
		)
	)
		throw new Error(
			"inventory completion cannot replace the prepared original",
		);
	const pending = rows.filter((row) => row.state !== "PURGED");
	if (
		pending.some(
			(row) =>
				!row.oldKey.startsWith(prefix) ||
				isFinishInventoryExempt(row.oldKey, prefix) ||
				!row.newKey.startsWith(`private/rollback/${videoId}/`) ||
				row.state === "ABORTED",
		)
	)
		throw new Error(
			"inventory completion encountered an unsafe relocation row",
		);
	for (const row of pending)
		await continueRelocation(row, store, journal, { kind: "rollback" });
	const scopedStore: ObjectStore = {
		...store,
		list: async (requested) => {
			if (requested !== prefix) throw new Error("inventory prefix mismatch");
			const keys = await list(requested);
			if (
				keys.some(
					(key) =>
						!isFinishInventoryExempt(key, prefix) && key.includes("/source/"),
				)
			)
				throw new Error(
					"inventory completion cannot replace the prepared original",
				);
			return keys.filter((key) => !isFinishInventoryExempt(key, prefix));
		},
	};
	await relocateOwnerVideo({
		ownerId: video.ownerId,
		videoId,
		store: scopedStore,
		journal: {
			...journal,
			listOpen: async () =>
				(await journal.listForVideo(videoId)).filter((row) =>
					["INTENT", "COPIED", "POINTER", "DELETED"].includes(row.state),
				),
		},
		sourceKey: source.liveKey,
	});
	assertFinishInventoryClear(await store.list(prefix), prefix);
	if (
		(await journal.listForVideo(videoId)).some((row) => row.state !== "PURGED")
	)
		throw new Error("inventory relocation is incomplete");
	const [after] = await app
		.select()
		.from(sourceObject)
		.where(eq(sourceObject.videoId, videoId as never));
	if (
		!after ||
		after.liveKey !== source.liveKey ||
		after.sha256 !== source.sha256 ||
		after.a1Digest !== source.a1Digest ||
		after.indexId !== source.indexId
	)
		throw new Error(
			"prepared original identity changed during inventory completion",
		);
}

const SHA64 = /^[a-f0-9]{64}$/;

function unsafeOriginKey(key: string) {
	return (
		!key ||
		key.includes("*") ||
		key.includes("?") ||
		key.includes("..") ||
		key.startsWith("/")
	);
}

function videoOwnedPrivateKey(videoId: string, key: string) {
	return (
		!unsafeOriginKey(key) &&
		(key.startsWith(`private/source/${videoId}/`) ||
			key.startsWith(`private/rollback/${videoId}/`))
	);
}

export function resolveRecordedOriginKeys(
	sources: Array<{
		videoId?: string;
		liveKey?: string;
		sha256?: string;
		relocationState?: string;
	}>,
	stages: Array<{
		videoId?: string;
		oldKey?: string;
		newKey?: string;
		sha256?: string;
		state?: string;
	}>,
) {
	const keys = new Set<string>();
	const byVideo = new Map<string, (typeof sources)[number]>();
	for (const source of sources) {
		if (source.videoId) byVideo.set(source.videoId, source);
		const liveKey = source.liveKey ?? "";
		if (
			liveKey.startsWith("private/source/") ||
			liveKey.startsWith("private/rollback/")
		) {
			if (!unsafeOriginKey(liveKey)) keys.add(liveKey);
		}
	}
	for (const stage of stages) {
		const source = stage.videoId ? byVideo.get(stage.videoId) : undefined;
		if (
			!source ||
			source.relocationState !== "LIVE" ||
			!stage.oldKey ||
			!stage.newKey ||
			stage.oldKey !== source.liveKey ||
			!stage.sha256 ||
			!SHA64.test(stage.sha256) ||
			stage.sha256 !== source.sha256 ||
			!["COPIED", "POINTER", "PURGED"].includes(stage.state ?? "") ||
			!stage.videoId ||
			!videoOwnedPrivateKey(stage.videoId, stage.newKey)
		) {
			continue;
		}
		keys.add(stage.newKey);
	}
	return [...keys].sort();
}

async function recordedOriginReadKeys(app: Database) {
	const sources = await app
		.select({
			videoId: sourceObject.videoId,
			liveKey: sourceObject.liveKey,
			sha256: sourceObject.sha256,
			relocationState: sourceObject.relocationState,
		})
		.from(sourceObject);
	const stages = await app
		.select({
			videoId: sourceRelocation.videoId,
			oldKey: sourceRelocation.oldKey,
			newKey: sourceRelocation.newKey,
			sha256: sourceRelocation.sha256,
			state: sourceRelocation.state,
		})
		.from(sourceRelocation);
	return resolveRecordedOriginKeys(sources, stages);
}

export async function refreshOriginReadPolicy(app: Database, liveKey: string) {
	const recorded = await recordedOriginReadKeys(app);
	const keys = recorded.includes(liveKey)
		? recorded
		: recorded.filter((key) => key !== liveKey);
	await publishRecordedKeys(keys);
}

let publishedKeyHash: string | null = null;
let missingCredentialHash: string | null = null;

export async function reconcileOriginReadPolicy(
	app: Database,
): Promise<boolean> {
	const keys = await recordedOriginReadKeys(app);
	const hash = createHash("sha256").update(keys.join("\n")).digest("hex");
	if (hash === publishedKeyHash) return true;
	try {
		const published = await publishRecordedKeys(keys);
		if (published) {
			publishedKeyHash = hash;
			missingCredentialHash = null;
		} else if (
			!process.env.MINIO_ROOT_USER ||
			!process.env.MINIO_ROOT_PASSWORD
		) {
			if (missingCredentialHash !== hash) {
				console.error(
					"origin read policy was not published: missing root credentials",
				);
				missingCredentialHash = hash;
			}
		}
		return published;
	} catch {
		console.error("origin read policy was not published");
		return false;
	}
}

async function publishRecordedKeys(keys: string[]): Promise<boolean> {
	const rootUser = process.env.MINIO_ROOT_USER;
	const rootPassword = process.env.MINIO_ROOT_PASSWORD;
	if (!rootUser || !rootPassword) return false;
	const env = serverEnv();
	const endpoint = env.S3_INTERNAL_ENDPOINT;
	if (!endpoint) {
		console.error("origin read policy was not published: missing endpoint");
		return false;
	}
	await publishOriginObjectPolicy({
		bucket: env.CAP_AWS_BUCKET,
		endpoint,
		keys,
		rootUser,
		rootPassword,
		policyName: process.env.ORIGIN_S3_POLICY ?? "instant-finish-origin-read",
	});
	return true;
}

async function publishOriginObjectPolicy(input: {
	bucket: string;
	endpoint: string;
	keys: string[];
	rootUser: string;
	rootPassword: string;
	policyName: string;
}) {
	const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const path = await import("node:path");
	const { spawn } = await import("node:child_process");
	const { originObjectPolicy } = await import("@/lib/origin-object-policy");
	const policy = originObjectPolicy(input.bucket, input.keys);
	const dir = await mkdtemp(path.join(tmpdir(), "origin-policy-"));
	const policyFile = path.join(dir, "policy.json");
	const envFile = path.join(dir, "mc.env");
	const endpoint = new URL(input.endpoint);
	const host = endpoint.host;
	const user = encodeURIComponent(input.rootUser);
	const password = encodeURIComponent(input.rootPassword);
	try {
		await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
		await writeFile(
			envFile,
			`MC_HOST_local=${endpoint.protocol}//${user}:${password}@${host}\n`,
			{ mode: 0o600 },
		);
		const run = (args: string[]) =>
			new Promise<number>((resolve, reject) => {
				const child = spawn(
					"docker",
					[
						"run",
						"--rm",
						"--network",
						"host",
						"--env-file",
						envFile,
						"-v",
						`${dir}:/policy:ro`,
						...args,
					],
					{ stdio: ["ignore", "ignore", "ignore"] },
				);
				child.on("error", reject);
				child.on("close", (code) => resolve(code ?? 1));
			});
		// One container for create+attach (each `docker run` costs ~0.55 s). The
		// policy name and user stay positional args ($1/$2), never shell text.
		// Exit 10 = create failed (nothing attached), 11 = attach failed.
		const accessKey = process.env.ORIGIN_S3_ACCESS_KEY;
		const script = [
			'mc admin policy create local "$1" /policy/policy.json || exit 10',
			'[ -z "$2" ] || mc admin policy attach local "$1" --user "$2" || exit 11',
		].join("\n");
		const code = await run([
			"--entrypoint",
			"sh",
			"minio/mc:RELEASE.2025-08-13T08-35-41Z",
			"-c",
			script,
			"mc-policy",
			input.policyName,
			accessKey ?? "",
		]);
		if (code !== 0) {
			throw new RevisionPublicationError(
				409,
				"Origin read policy was not updated for the relocated key",
			);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

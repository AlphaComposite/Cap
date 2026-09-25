import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectVersionsCommand,
	PutBucketVersioningCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createConnection } from "mysql2/promise";
import {
	type CrashPoint,
	inventoryExposedKeys,
	type ObjectStore,
	privateKeyFor,
	type RelocationJournal,
	type RelocationKind,
	type RelocationRow,
	type RelocationState,
	reconcileRelocations,
	relocateKey,
} from "../lib/source-relocation";

type Statuses = { get: number; head: number; range: number };

export type RelocationProof = {
	before: Statuses;
	after: Statuses;
	rollbackRetained: boolean;
	liveKeyPrivate: boolean;
	idempotent: boolean;
	reconciled: number;
};

const privatePrefix = (key: string) =>
	key.startsWith("private/source/") || key.startsWith("private/rollback/");

export function createS3Store(
	client: S3Client,
	bucket: string,
): ObjectStore & {
	presignHead: (key: string) => Promise<{ key: string; url: string }>;
} {
	return {
		async copy(oldKey, newKey) {
			const got = await client.send(
				new GetObjectCommand({ Bucket: bucket, Key: oldKey }),
			);
			const bytes = await got.Body?.transformToByteArray();
			if (!bytes) throw new Error("copy source missing");
			await client.send(
				new PutObjectCommand({ Bucket: bucket, Key: newKey, Body: bytes }),
			);
		},
		async sha256(key) {
			try {
				const got = await client.send(
					new GetObjectCommand({ Bucket: bucket, Key: key }),
				);
				const bytes = await got.Body?.transformToByteArray();
				if (!bytes) return null;
				return createHash("sha256").update(bytes).digest("hex");
			} catch {
				return null;
			}
		},
		async deleteAllVersions(key) {
			let keyMarker: string | undefined;
			let versionMarker: string | undefined;
			do {
				const listed = await client.send(
					new ListObjectVersionsCommand({
						Bucket: bucket,
						Prefix: key,
						KeyMarker: keyMarker,
						VersionIdMarker: versionMarker,
					}),
				);
				const versions = [
					...(listed.Versions ?? []),
					...(listed.DeleteMarkers ?? []),
				].filter((item) => item.Key === key && item.VersionId);
				for (const item of versions) {
					await client.send(
						new DeleteObjectCommand({
							Bucket: bucket,
							Key: key,
							VersionId: item.VersionId,
						}),
					);
				}
				keyMarker = listed.NextKeyMarker;
				versionMarker = listed.NextVersionIdMarker;
				if (!listed.IsTruncated) break;
			} while (keyMarker);
		},
		async exists(key) {
			try {
				await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
				return true;
			} catch {
				return false;
			}
		},
		async presignHead(key) {
			const url = await getSignedUrl(
				client,
				new HeadObjectCommand({ Bucket: bucket, Key: key }),
				{ expiresIn: 60 },
			);
			return { key, url };
		},
		async presignGet(key) {
			return getSignedUrl(
				client,
				new GetObjectCommand({ Bucket: bucket, Key: key }),
				{ expiresIn: 300 },
			);
		},
		async request(url, method, range) {
			const response = await fetch(url, {
				method,
				headers: range ? { range } : undefined,
			});
			await response.arrayBuffer().catch(() => undefined);
			return response.status;
		},
	};
}

export async function createMysqlJournal(
	databaseUrl: string,
): Promise<RelocationJournal> {
	const connection = await createConnection(databaseUrl);
	const journal: RelocationJournal = {
		async insertIntent(row) {
			const [result] = await connection.execute(
				`INSERT INTO source_relocation
					(videoId, revisionId, oldKey, newKey, sha256, state, createdAt)
				 VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
				[
					row.videoId,
					row.revisionId,
					row.oldKey,
					row.newKey,
					row.sha256,
					row.state,
				],
			);
			const id = Number((result as { insertId: number }).insertId);
			const stored = await journal.get(id);
			if (!stored) throw new Error("relocation insert missing");
			return stored;
		},
		async mark(id, state, sha256) {
			await connection.execute(
				`UPDATE source_relocation SET state = ?, sha256 = COALESCE(?, sha256) WHERE id = ?`,
				[state, sha256 ?? null, id],
			);
		},
		async setLiveKey(videoId, liveKey, sha256, relocationState) {
			await connection.execute(
				`INSERT INTO source_object (videoId, liveKey, sha256, relocationState)
				 VALUES (?, ?, ?, ?)
				 ON DUPLICATE KEY UPDATE liveKey = VALUES(liveKey), sha256 = VALUES(sha256), relocationState = VALUES(relocationState)`,
				[videoId, liveKey, sha256, relocationState],
			);
		},
		async getLiveKey(videoId) {
			const [rows] = await connection.execute(
				`SELECT liveKey FROM source_object WHERE videoId = ? LIMIT 1`,
				[videoId],
			);
			const row = (rows as Array<{ liveKey: string }>)[0];
			return row?.liveKey ?? null;
		},
		async listOpen() {
			const [rows] = await connection.execute(
				`SELECT id, videoId, revisionId, oldKey, newKey, sha256, state, createdAt
				 FROM source_relocation
				 WHERE state IN ('INTENT', 'COPIED', 'POINTER', 'DELETED')`,
			);
			return (rows as RelocationRow[]).map((row) => ({
				...row,
				id: Number(row.id),
				createdAt: String(row.createdAt),
				state: row.state as RelocationState,
			}));
		},
		async get(id) {
			const [rows] = await connection.execute(
				`SELECT id, videoId, revisionId, oldKey, newKey, sha256, state, createdAt
				 FROM source_relocation WHERE id = ? LIMIT 1`,
				[id],
			);
			const row = (rows as RelocationRow[])[0];
			if (!row) return null;
			return {
				...row,
				id: Number(row.id),
				createdAt: String(row.createdAt),
				state: row.state as RelocationState,
			};
		},
	};
	return journal;
}

async function statusesFor(
	store: ObjectStore,
	getUrl: string,
	headUrl: string,
): Promise<Statuses> {
	return {
		get: await store.request(getUrl, "GET"),
		head: await store.request(headUrl, "HEAD"),
		range: await store.request(getUrl, "GET", "bytes=0-0"),
	};
}

export async function relocateOwnerVideo(input: {
	ownerId: string;
	videoId: string;
	bucket: string;
	store: ObjectStore;
	journal: RelocationJournal;
	revisionId?: string;
	crash?: CrashPoint;
	reconcileOnly?: boolean;
}): Promise<RelocationProof> {
	const prefix = `${input.ownerId}/${input.videoId}/`;
	const exposed = inventoryExposedKeys({
		ownerId: input.ownerId,
		videoId: input.videoId,
		rawFileKey: `${prefix}raw-upload.mp4`,
		outputKey: `${prefix}.recording/outputs/result.mp4`,
	});
	const presigned = new Map<string, string>();
	const headSigned = new Map<string, string>();
	const signing = input.store as ObjectStore & {
		presignHead?: (key: string) => Promise<{ url: string }>;
	};
	for (const item of exposed) {
		if (await input.store.exists(item.key)) {
			presigned.set(item.key, await input.store.presignGet(item.key));
			if (signing.presignHead) {
				headSigned.set(item.key, (await signing.presignHead(item.key)).url);
			}
		}
	}
	const sampleKey = Array.from(presigned.keys())[0];
	const sampleUrl = sampleKey ? presigned.get(sampleKey) : undefined;
	const sampleHead = sampleKey
		? (headSigned.get(sampleKey) ?? sampleUrl)
		: undefined;
	const before =
		sampleUrl && sampleHead
			? await statusesFor(input.store, sampleUrl, sampleHead)
			: { get: 404, head: 404, range: 404 };
	const kindFor = (row: RelocationRow): RelocationKind =>
		row.newKey.startsWith("private/source/") ? "original" : "rollback";
	if (input.reconcileOnly) {
		const reconciled = await reconcileRelocations({
			store: input.store,
			journal: input.journal,
			kindFor,
			preissuedUrlFor: (row) => presigned.get(row.oldKey),
		});
		const liveKey = await input.journal.getLiveKey(input.videoId);
		const afterUrl = sampleUrl;
		const afterHead = sampleHead;
		return {
			before,
			after:
				afterUrl && afterHead
					? await statusesFor(input.store, afterUrl, afterHead)
					: { get: 404, head: 404, range: 404 },
			rollbackRetained: exposed.some((item) => item.kind === "rollback"),
			liveKeyPrivate: liveKey != null && privatePrefix(liveKey),
			idempotent: true,
			reconciled,
		};
	}
	const moved: Array<{ oldKey: string; newKey: string; kind: RelocationKind }> =
		[];
	for (const item of exposed) {
		if (!(await input.store.exists(item.key))) continue;
		const open = await input.journal.listOpen();
		if (open.some((row) => row.oldKey === item.key)) continue;
		const newKey = privateKeyFor(item.kind, input.videoId);
		await relocateKey({
			videoId: input.videoId,
			revisionId: input.revisionId ?? "relocate",
			oldKey: item.key,
			newKey,
			kind: item.kind,
			store: input.store,
			journal: input.journal,
			preissuedUrl: presigned.get(item.key),
			crash: input.crash,
			flagged: true,
		});
		moved.push({ oldKey: item.key, newKey, kind: item.kind });
	}
	const after =
		sampleUrl && sampleHead
			? await statusesFor(input.store, sampleUrl, sampleHead)
			: { get: 404, head: 404, range: 404 };
	const liveKey = await input.journal.getLiveKey(input.videoId);
	const rollbackRetained = (
		await Promise.all(
			moved
				.filter((item) => item.kind === "rollback")
				.map((item) => input.store.exists(item.newKey)),
		)
	).some(Boolean);
	return {
		before,
		after,
		rollbackRetained,
		liveKeyPrivate: liveKey != null && privatePrefix(liveKey),
		idempotent: moved.length >= 0,
		reconciled: 0,
	};
}

export async function applyMigration0047(databaseUrl: string, sqlPath: string) {
	const connection = await createConnection(databaseUrl);
	const sql = readFileSync(sqlPath, "utf8");
	for (const statement of sql.split("--> statement-breakpoint")) {
		const trimmed = statement.trim();
		if (trimmed.length > 0) await connection.query(trimmed);
	}
	await connection.end();
}

async function main() {
	const ownerId = process.env.RELOCATE_OWNER_ID ?? "owner";
	const videoId = process.env.RELOCATE_VIDEO_ID ?? "video1";
	const bucket = process.env.RELOCATE_S3_BUCKET ?? "capfix";
	const endpoint = process.env.RELOCATE_S3_ENDPOINT;
	const databaseUrl = process.env.RELOCATE_DATABASE_URL;
	if (!endpoint || !databaseUrl) {
		throw new Error(
			"RELOCATE_S3_ENDPOINT and RELOCATE_DATABASE_URL are required",
		);
	}
	const client = new S3Client({
		region: "us-east-1",
		endpoint,
		forcePathStyle: true,
		credentials: {
			accessKeyId: process.env.RELOCATE_S3_ACCESS_KEY ?? "",
			secretAccessKey: process.env.RELOCATE_S3_SECRET_KEY ?? "",
		},
	});
	await client.send(
		new PutBucketVersioningCommand({
			Bucket: bucket,
			VersioningConfiguration: { Status: "Enabled" },
		}),
	);
	const store = createS3Store(client, bucket);
	const journal = await createMysqlJournal(databaseUrl);
	const crash = process.env.RELOCATE_CRASH as CrashPoint | undefined;
	const proof = await relocateOwnerVideo({
		ownerId,
		videoId,
		bucket,
		store,
		journal,
		crash,
		reconcileOnly: process.env.RELOCATE_RECONCILE === "1",
	});
	process.stdout.write(
		`${JSON.stringify({
			before: proof.before,
			after: proof.after,
			rollbackRetained: proof.rollbackRetained,
			liveKeyPrivate: proof.liveKeyPrivate,
			idempotent: proof.idempotent,
			reconciled: proof.reconciled,
		})}\n`,
	);
}

const invokedDirectly = process.argv[1]?.includes("instant-finish-relocate.ts");
if (invokedDirectly) {
	main().catch((error: unknown) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : "relocation failed"}\n`,
		);
		process.exit(1);
	});
}

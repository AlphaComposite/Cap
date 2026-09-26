import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	ListObjectVersionsCommand,
	PutBucketVersioningCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createConnection } from "mysql2/promise";
import { deletionPlan } from "@/lib/origin-object-policy";
import {
	type CrashPoint,
	type ObjectStore,
	type RelocationJournal,
	type RelocationRow,
	type RelocationState,
	relocateOwnerVideo as relocateOwnerVideoShared,
} from "../lib/source-relocation";

export function createS3Store(
	client: S3Client,
	bucket: string,
): ObjectStore & {
	presignHead: (key: string) => Promise<string>;
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
			const listedItems: { Key?: string; VersionId?: string }[] = [];
			do {
				const listed = await client.send(
					new ListObjectVersionsCommand({
						Bucket: bucket,
						Prefix: key,
						KeyMarker: keyMarker,
						VersionIdMarker: versionMarker,
					}),
				);
				listedItems.push(
					...(listed.Versions ?? []),
					...(listed.DeleteMarkers ?? []),
				);
				keyMarker = listed.NextKeyMarker;
				versionMarker = listed.NextVersionIdMarker;
				if (!listed.IsTruncated) break;
			} while (keyMarker);
			const plan = deletionPlan(listedItems, key);
			for (const versionId of plan.versionIds) {
				await client.send(
					new DeleteObjectCommand({
						Bucket: bucket,
						Key: key,
						VersionId: versionId,
					}),
				);
			}
			if (plan.deleteCurrent) {
				await client.send(
					new DeleteObjectCommand({
						Bucket: bucket,
						Key: key,
					}),
				);
			}
		},
		async exists(key) {
			try {
				await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
				return true;
			} catch {
				return false;
			}
		},
		async list(prefix) {
			const keys: string[] = [];
			let token: string | undefined;
			do {
				const listed = await client.send(
					new ListObjectsV2Command({
						Bucket: bucket,
						Prefix: prefix,
						ContinuationToken: token,
					}),
				);
				for (const item of listed.Contents ?? []) {
					if (item.Key) keys.push(item.Key);
				}
				token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
			} while (token);
			return keys;
		},
		async listVersions(key) {
			const versions: string[] = [];
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
				for (const item of [
					...(listed.Versions ?? []),
					...(listed.DeleteMarkers ?? []),
				]) {
					if (item.Key === key && item.VersionId) versions.push(item.VersionId);
				}
				keyMarker = listed.NextKeyMarker;
				versionMarker = listed.NextVersionIdMarker;
				if (!listed.IsTruncated) break;
			} while (keyMarker);
			return versions;
		},
		async presignHead(key) {
			return getSignedUrl(
				client,
				new HeadObjectCommand({ Bucket: bucket, Key: key }),
				{ expiresIn: 60 },
			);
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

function mapRow(row: RelocationRow): RelocationRow {
	return {
		...row,
		id: Number(row.id),
		createdAt: String(row.createdAt),
		state: row.state as RelocationState,
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
			return (rows as RelocationRow[]).map(mapRow);
		},
		async listForVideo(videoId) {
			const [rows] = await connection.execute(
				`SELECT id, videoId, revisionId, oldKey, newKey, sha256, state, createdAt
				 FROM source_relocation WHERE videoId = ?`,
				[videoId],
			);
			return (rows as RelocationRow[]).map(mapRow);
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

export async function relocateOwnerVideo(input: {
	ownerId: string;
	videoId: string;
	bucket: string;
	store: ObjectStore;
	journal: RelocationJournal;
	referencedKeys?: Array<string | null | undefined>;
	sourceKey?: string | null;
	revisionId?: string;
	crash?: CrashPoint;
	reconcileOnly?: boolean;
}) {
	const prefix = `${input.ownerId}/${input.videoId}/`;
	return relocateOwnerVideoShared({
		ownerId: input.ownerId,
		videoId: input.videoId,
		store: input.store,
		journal: input.journal,
		sourceKey: input.sourceKey ?? `${prefix}source/original.mp4`,
		rawFileKey: `${prefix}raw-upload.mp4`,
		outputKey: `${prefix}.recording/outputs/result.mp4`,
		referencedKeys: input.referencedKeys,
		revisionId: input.revisionId,
		crash: input.crash,
		reconcileOnly: input.reconcileOnly,
	});
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
			liveKey: proof.liveKey,
			liveKeyPrivate: proof.liveKeyPrivate,
			idempotent: proof.idempotent,
			moved: proof.moved,
		})}\n`,
	);
	if (proof.idempotent && proof.moved === 0 && !proof.liveKeyPrivate) {
		throw new Error("relocation no-op is not a successful purge");
	}
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

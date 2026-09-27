import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CopyObjectCommand,
	CreateMultipartUploadCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	ListObjectVersionsCommand,
	PutBucketVersioningCommand,
	S3Client,
	UploadPartCopyCommand,
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

const COPY_OBJECT_LIMIT = 5 * 1024 * 1024 * 1024;
const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_COPY_PARTS = 10_000;

function encodedCopySource(bucket: string, key: string): string {
	return `${encodeURIComponent(bucket)}/${key
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/")}`;
}

function multipartPartSize(size: number): number {
	if (Math.ceil(size / MIN_PART_BYTES) <= MAX_COPY_PARTS) return MIN_PART_BYTES;
	return Math.ceil(size / MAX_COPY_PARTS);
}

export function createS3Store(
	client: S3Client,
	bucket: string,
): ObjectStore & {
	presignHead: (key: string) => Promise<string>;
} {
	return {
		async copy(oldKey, newKey) {
			const head = await client.send(
				new HeadObjectCommand({ Bucket: bucket, Key: oldKey }),
			);
			if (head.ContentLength === undefined) {
				throw new Error("copy source size unknown");
			}
			const size = head.ContentLength;
			const copySource = encodedCopySource(bucket, oldKey);
			if (size <= COPY_OBJECT_LIMIT) {
				await client.send(
					new CopyObjectCommand({
						Bucket: bucket,
						Key: newKey,
						CopySource: copySource,
					}),
				);
				return;
			}
			const created = await client.send(
				new CreateMultipartUploadCommand({ Bucket: bucket, Key: newKey }),
			);
			const uploadId = created.UploadId;
			if (!uploadId) throw new Error("multipart copy missing upload id");
			try {
				const partSize = multipartPartSize(size);
				const parts: { ETag: string | undefined; PartNumber: number }[] = [];
				let start = 0;
				let partNumber = 1;
				while (start < size) {
					const end = Math.min(start + partSize, size) - 1;
					const copied = await client.send(
						new UploadPartCopyCommand({
							Bucket: bucket,
							Key: newKey,
							UploadId: uploadId,
							PartNumber: partNumber,
							CopySource: copySource,
							CopySourceRange: `bytes=${start}-${end}`,
						}),
					);
					parts.push({
						ETag: copied.CopyPartResult?.ETag,
						PartNumber: partNumber,
					});
					start = end + 1;
					partNumber += 1;
				}
				await client.send(
					new CompleteMultipartUploadCommand({
						Bucket: bucket,
						Key: newKey,
						UploadId: uploadId,
						MultipartUpload: { Parts: parts },
					}),
				);
			} catch (error) {
				await client
					.send(
						new AbortMultipartUploadCommand({
							Bucket: bucket,
							Key: newKey,
							UploadId: uploadId,
						}),
					)
					.catch(() => undefined);
				throw error;
			}
		},
		async sha256(key) {
			try {
				const got = await client.send(
					new GetObjectCommand({ Bucket: bucket, Key: key }),
				);
				const body = got.Body;
				if (!body) return null;
				const hash = createHash("sha256");
				for await (const chunk of body as AsyncIterable<Uint8Array>) {
					hash.update(chunk);
				}
				return hash.digest("hex");
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
			// Next's patched fetch memoizes the pre-delete GET, so this probe would
			// still see 200 after the object is gone. Use the raw client.
			const { request: httpRequest } = await import("node:http");
			const { request: httpsRequest } = await import("node:https");
			const parsed = new URL(url);
			const transport =
				parsed.protocol === "https:" ? httpsRequest : httpRequest;
			return await new Promise<number>((resolve, reject) => {
				const req = transport(
					url,
					{
						method,
						headers: range ? { range } : undefined,
					},
					(res) => {
						res.resume();
						resolve(res.statusCode ?? 0);
					},
				);
				req.on("error", reject);
				req.end();
			});
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

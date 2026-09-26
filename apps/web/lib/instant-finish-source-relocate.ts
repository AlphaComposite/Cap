import { S3Client } from "@aws-sdk/client-s3";
import { db } from "@cap/database";
import {
	sourceObject,
	sourceRelocation,
	videoEdits,
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { and, eq } from "drizzle-orm";
import { RevisionPublicationError } from "@/lib/revision-publication-metadata";
import {
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

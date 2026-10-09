import { createHash, randomBytes } from "node:crypto";
import { RevisionPublicationError } from "@/lib/revision-publication-metadata";
import { SOURCE_RELOCATION_PENDING_MESSAGE } from "@/lib/revision-publish-client";

export type RelocationKind = "original" | "rollback";

export type RelocationState =
	| "INTENT"
	| "COPIED"
	| "POINTER"
	| "DELETED"
	| "PURGED"
	| "ABORTED";

export type CrashPoint =
	| "after_intent"
	| "after_copy"
	| "after_pointer"
	| "after_delete"
	| "after_purge";

export class RelocationCrash extends Error {
	constructor(readonly point: CrashPoint) {
		super("relocation crash");
		this.name = "RelocationCrash";
	}
}

export type RelocationRow = {
	id: number;
	videoId: string;
	revisionId: string;
	oldKey: string;
	newKey: string;
	sha256: string;
	state: RelocationState;
	createdAt: string;
};

export type ObjectStore = {
	copy(oldKey: string, newKey: string): Promise<void>;
	sha256(key: string): Promise<string | null>;
	deleteAllVersions(key: string): Promise<void>;
	exists(key: string): Promise<boolean>;
	presignGet(key: string): Promise<string>;
	presignHead?(key: string): Promise<string>;
	list?(prefix: string): Promise<string[]>;
	listVersions?(key: string): Promise<string[]>;
	request(url: string, method: "GET" | "HEAD", range?: string): Promise<number>;
};

export type RelocationJournal = {
	insertIntent(
		row: Omit<RelocationRow, "id" | "createdAt">,
	): Promise<RelocationRow>;
	mark(id: number, state: RelocationState, sha256?: string): Promise<void>;
	setLiveKey(
		videoId: string,
		liveKey: string,
		sha256: string,
		relocationState: string,
	): Promise<void>;
	getLiveKey(videoId: string): Promise<string | null>;
	listOpen(): Promise<RelocationRow[]>;
	listForVideo(videoId: string): Promise<RelocationRow[]>;
	get(id: number): Promise<RelocationRow | null>;
};

export type PurgeClient = {
	purge(urls: string[]): Promise<{ accepted: boolean }>;
};

export type ExposedKey = {
	key: string;
	kind: RelocationKind;
};

const TRANSCRIPT_LANG_REST = /^transcription\.[a-z]{2}\.vtt$/;

export function isRetainedTranscriptKey(key: string, prefix: string) {
	if (!key.startsWith(prefix)) return false;
	const rest = key.slice(prefix.length);
	return (
		rest === "transcription.vtt" ||
		TRANSCRIPT_LANG_REST.test(rest) ||
		rest === "transcription.edit.v3.json" ||
		rest === "transcription.edit.v3.status.json"
	);
}

export function isFinishInventoryExempt(key: string, prefix: string) {
	return (
		isRetainedTranscriptKey(key, prefix) || key.startsWith(`${prefix}comments/`)
	);
}

export function assertFinishInventoryClear(
	listed: readonly string[] | null | undefined,
	prefix: string,
) {
	if (!listed || listed.some((key) => !isFinishInventoryExempt(key, prefix))) {
		throw new RevisionPublicationError(409, SOURCE_RELOCATION_PENDING_MESSAGE);
	}
}

export function inventoryExposedKeys(input: {
	ownerId: string;
	videoId: string;
	sourceKey?: string | null;
	rawFileKey?: string | null;
	outputKey?: string | null;
	thumbnailKey?: string | null;
	previewKey?: string | null;
	extraKeys?: Array<string | null | undefined>;
}): ExposedKey[] {
	const prefix = `${input.ownerId}/${input.videoId}/`;
	const keys = new Map<string, RelocationKind>();
	const add = (key: string | null | undefined, kind: RelocationKind) => {
		if (!key || !key.startsWith(prefix)) return;
		if (key.startsWith("private/")) return;
		if (isRetainedTranscriptKey(key, prefix)) return;
		const existing = keys.get(key);
		if (existing === "original") return;
		keys.set(key, kind);
	};
	add(`${prefix}source/original.mp4`, "original");
	add(input.sourceKey, "original");
	add(`${prefix}result.mp4`, "rollback");
	add(input.rawFileKey, "rollback");
	add(input.outputKey, "rollback");
	add(input.thumbnailKey, "rollback");
	add(input.previewKey, "rollback");
	add(`${prefix}screenshot/screen-capture.jpg`, "rollback");
	add(`${prefix}screenshot.jpg`, "rollback");
	add(`${prefix}preview/animated-preview.gif`, "rollback");
	for (const key of input.extraKeys ?? []) {
		add(key, key?.includes("/source/") ? "original" : "rollback");
	}
	return [...keys.entries()].map(([key, kind]) => ({ key, kind }));
}

export function privateKeyFor(kind: RelocationKind, videoId: string) {
	const opaque = randomBytes(16).toString("base64url");
	return kind === "original"
		? `private/source/${videoId}/${opaque}`
		: `private/rollback/${videoId}/${opaque}`;
}

export function sha256Bytes(bytes: Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}

const crashAt = (point: CrashPoint, requested?: CrashPoint) => {
	if (requested === point) throw new RelocationCrash(point);
};

export async function relocateKey(input: {
	videoId: string;
	revisionId: string;
	oldKey: string;
	newKey: string;
	kind: RelocationKind;
	store: ObjectStore;
	journal: RelocationJournal;
	purge?: PurgeClient;
	purgeUrls?: string[];
	preissuedUrl?: string;
	probes?: Array<{ url: string; method: "GET" | "HEAD"; range?: string }>;
	crash?: CrashPoint;
	flagged?: boolean;
}): Promise<{ id: number; sha256: string; purged: boolean }> {
	if (input.flagged === false) {
		throw new Error("relocation refused while flag is off");
	}
	const sha = await input.store.sha256(input.oldKey);
	if (!sha) throw new Error("source object missing before relocation");
	const row = await input.journal.insertIntent({
		videoId: input.videoId,
		revisionId: input.revisionId,
		oldKey: input.oldKey,
		newKey: input.newKey,
		sha256: sha,
		state: "INTENT",
	});
	crashAt("after_intent", input.crash);
	await continueRelocation(row, input.store, input.journal, {
		kind: input.kind,
		purge: input.purge,
		purgeUrls: input.purgeUrls,
		preissuedUrl: input.preissuedUrl,
		probes: input.probes,
		crash: input.crash,
	});
	return { id: row.id, sha256: sha, purged: !input.crash };
}

export async function continueRelocation(
	row: RelocationRow,
	store: ObjectStore,
	journal: RelocationJournal,
	extra: {
		kind: RelocationKind;
		purge?: PurgeClient;
		purgeUrls?: string[];
		preissuedUrl?: string;
		probes?: Array<{ url: string; method: "GET" | "HEAD"; range?: string }>;
		crash?: CrashPoint;
	},
) {
	let state = row.state;
	if (state === "INTENT") {
		const copiedSha = await store.sha256(row.newKey);
		if (copiedSha === null) {
			await store.copy(row.oldKey, row.newKey);
		}
		const verified = await store.sha256(row.newKey);
		if (verified !== row.sha256) {
			if (verified !== null) await store.deleteAllVersions(row.newKey);
			await journal.mark(row.id, "ABORTED");
			throw new Error("relocated object sha256 mismatch");
		}
		const oldStill = await store.sha256(row.oldKey);
		if (oldStill !== null && oldStill !== row.sha256) {
			await store.deleteAllVersions(row.newKey);
			await journal.mark(row.id, "ABORTED");
			throw new Error("source changed during copy");
		}
		await journal.mark(row.id, "COPIED", verified);
		state = "COPIED";
		crashAt("after_copy", extra.crash);
	}
	if (state === "COPIED") {
		if (extra.kind === "original") {
			await journal.setLiveKey(row.videoId, row.newKey, row.sha256, "COPIED");
		}
		await journal.mark(row.id, "POINTER", row.sha256);
		state = "POINTER";
		crashAt("after_pointer", extra.crash);
	}
	if (state === "POINTER") {
		const verified = await store.sha256(row.newKey);
		if (verified !== row.sha256) {
			throw new Error("refusing to delete old key without a verified copy");
		}
		if (row.oldKey !== row.newKey) await store.deleteAllVersions(row.oldKey);
		await journal.mark(row.id, "DELETED", row.sha256);
		if (extra.kind === "original") {
			await journal.setLiveKey(row.videoId, row.newKey, row.sha256, "DELETED");
		}
		state = "DELETED";
		crashAt("after_delete", extra.crash);
	}
	if (state === "DELETED") {
		if (row.oldKey !== row.newKey && (await store.exists(row.oldKey))) {
			throw new Error("old key still exists after delete");
		}
		const probes = [
			...(extra.preissuedUrl
				? [
						{ url: extra.preissuedUrl, method: "GET" as const },
						{ url: extra.preissuedUrl, method: "HEAD" as const },
						{
							url: extra.preissuedUrl,
							method: "GET" as const,
							range: "bytes=0-0",
						},
					]
				: []),
			...(extra.probes ?? []),
		];
		for (const probe of probes) {
			const status = await store.request(probe.url, probe.method, probe.range);
			if (status < 400) {
				throw new Error("preissued url still readable after delete");
			}
		}
		const urls = extra.purgeUrls ?? [];
		if (urls.length > 0) {
			const purged = await extra.purge?.purge(urls);
			if (!purged?.accepted) return;
		}
		await journal.mark(row.id, "PURGED", row.sha256);
		if (extra.kind === "original") {
			await journal.setLiveKey(row.videoId, row.newKey, row.sha256, "PURGED");
		}
		crashAt("after_purge", extra.crash);
	}
}

export async function reconcileRelocations(input: {
	store: ObjectStore;
	journal: RelocationJournal;
	kindFor: (row: RelocationRow) => RelocationKind;
	purge?: PurgeClient;
	purgeUrlsFor?: (row: RelocationRow) => string[];
	preissuedUrlFor?: (row: RelocationRow) => string | undefined;
}): Promise<number> {
	const open = await input.journal.listOpen();
	for (const row of open) {
		if (row.state === "INTENT") {
			const newSha = await input.store.sha256(row.newKey);
			const oldSha = await input.store.sha256(row.oldKey);
			if (newSha === null && oldSha !== row.sha256) {
				throw new Error("relocation reconcile refused to drop the only copy");
			}
			if (newSha !== null && newSha !== row.sha256) {
				await input.store.deleteAllVersions(row.newKey);
				if (oldSha !== row.sha256) {
					throw new Error("relocation reconcile refused to drop the only copy");
				}
				await input.journal.mark(row.id, "ABORTED");
				continue;
			}
		}
		await continueRelocation(row, input.store, input.journal, {
			kind: input.kindFor(row),
			purge: input.purge,
			purgeUrls: input.purgeUrlsFor?.(row),
			preissuedUrl: input.preissuedUrlFor?.(row),
		});
	}
	return open.length;
}

export function createMemoryJournal(): RelocationJournal & {
	rows: RelocationRow[];
	live: Map<
		string,
		{ liveKey: string; sha256: string; relocationState: string }
	>;
} {
	const rows: RelocationRow[] = [];
	const live = new Map<
		string,
		{ liveKey: string; sha256: string; relocationState: string }
	>();
	let nextId = 1;
	return {
		rows,
		live,
		async insertIntent(row) {
			const stored: RelocationRow = {
				...row,
				id: nextId,
				createdAt: new Date(0).toISOString(),
			};
			nextId += 1;
			rows.push(stored);
			return stored;
		},
		async mark(id, state, sha256) {
			const row = rows.find((item) => item.id === id);
			if (!row) throw new Error("relocation row missing");
			row.state = state;
			if (sha256) row.sha256 = sha256;
		},
		async setLiveKey(videoId, liveKey, sha256, relocationState) {
			live.set(videoId, { liveKey, sha256, relocationState });
		},
		async getLiveKey(videoId) {
			return live.get(videoId)?.liveKey ?? null;
		},
		async listOpen() {
			return rows.filter((row) =>
				["INTENT", "COPIED", "POINTER", "DELETED"].includes(row.state),
			);
		},
		async listForVideo(videoId) {
			return rows.filter((row) => row.videoId === videoId);
		},
		async get(id) {
			return rows.find((row) => row.id === id) ?? null;
		},
	};
}

export function assertFinishSourceKey(input: {
	liveKey: string;
	relocations: Array<{ newKey: string; state: string }>;
}) {
	const relocated = input.relocations.find(
		(item) =>
			item.newKey.startsWith("private/source/") &&
			item.state === "PURGED" &&
			item.newKey === input.liveKey,
	);
	if (!relocated) {
		throw new Error(SOURCE_RELOCATION_PENDING_MESSAGE);
	}
	return input.liveKey;
}

export function resolveLegacySourceKey(input: {
	sourceKey: string;
	liveKey: string | null;
	relocations: Array<{
		oldKey: string;
		newKey: string;
		state: RelocationState;
	}>;
}) {
	const moved = input.relocations.find(
		(row) =>
			row.oldKey === input.sourceKey &&
			(row.state === "POINTER" ||
				row.state === "DELETED" ||
				row.state === "PURGED" ||
				row.state === "COPIED"),
	);
	if (input.liveKey && moved) return input.liveKey;
	if (moved) return moved.newKey;
	return input.sourceKey;
}

export type KeyProbe = { get: number; head: number; range: number };

export type RelocationProof = {
	before: Record<string, KeyProbe>;
	after: Record<string, KeyProbe>;
	liveKey: string | null;
	liveKeyPrivate: boolean;
	idempotent: boolean;
	moved: number;
};

async function probeUrl(
	store: ObjectStore,
	getUrl: string,
	headUrl: string,
): Promise<KeyProbe> {
	return {
		get: await store.request(getUrl, "GET"),
		head: await store.request(headUrl, "HEAD"),
		range: await store.request(getUrl, "GET", "bytes=0-0"),
	};
}

function refused(probe: KeyProbe) {
	return probe.get >= 400 && probe.head >= 400 && probe.range >= 400;
}

export async function relocateOwnerVideo(input: {
	ownerId: string;
	videoId: string;
	store: ObjectStore;
	journal: RelocationJournal;
	referencedKeys?: Array<string | null | undefined>;
	sourceKey?: string | null;
	rawFileKey?: string | null;
	outputKey?: string | null;
	revisionId?: string;
	crash?: CrashPoint;
	reconcileOnly?: boolean;
}): Promise<RelocationProof> {
	const prefix = `${input.ownerId}/${input.videoId}/`;
	const listed = input.store.list ? await input.store.list(prefix) : [];
	const exposed = inventoryExposedKeys({
		ownerId: input.ownerId,
		videoId: input.videoId,
		sourceKey: input.sourceKey,
		rawFileKey: input.rawFileKey,
		outputKey: input.outputKey,
		extraKeys: [...(input.referencedKeys ?? []), ...listed],
	});
	const presigned = new Map<string, string>();
	const headSigned = new Map<string, string>();
	for (const item of exposed) {
		if (!(await input.store.exists(item.key))) continue;
		presigned.set(item.key, await input.store.presignGet(item.key));
		if (input.store.presignHead) {
			headSigned.set(item.key, await input.store.presignHead(item.key));
		}
	}
	const before: Record<string, KeyProbe> = {};
	for (const [key, url] of presigned) {
		before[key] = await probeUrl(input.store, url, headSigned.get(key) ?? url);
	}
	const kindFor = (row: RelocationRow): RelocationKind =>
		row.newKey.startsWith("private/source/") ? "original" : "rollback";
	if (input.reconcileOnly) {
		await reconcileRelocations({
			store: input.store,
			journal: input.journal,
			kindFor,
			preissuedUrlFor: (row) => presigned.get(row.oldKey),
		});
	}
	const moved: string[] = [];
	if (!input.reconcileOnly) {
		const assertCurrentOpen = async (open: RelocationRow[]) => {
			const openOriginals: string[] = [];
			const freshOriginals: string[] = [];
			for (const item of exposed) {
				const matching = open.filter((row) => row.oldKey === item.key);
				if (matching.length > 1) {
					throw new Error(`ambiguous open relocation for ${item.key}`);
				}
				for (const row of matching) {
					const destinationOk =
						row.newKey.startsWith(`private/source/${input.videoId}/`) ||
						row.newKey.startsWith(`private/rollback/${input.videoId}/`);
					if (
						row.videoId !== input.videoId ||
						!row.oldKey.startsWith(prefix) ||
						!destinationOk
					) {
						throw new Error(`open relocation video mismatch for ${item.key}`);
					}
				}
				const row = matching[0];
				const exists = await input.store.exists(item.key);
				if (
					row &&
					(exists || row.state === "DELETED") &&
					row.newKey.startsWith(`private/source/${input.videoId}/`)
				) {
					openOriginals.push(item.key);
				} else if (!row && exists && item.kind === "original") {
					freshOriginals.push(item.key);
				}
			}
			if (
				openOriginals.length > 1 ||
				(openOriginals.length === 1 && freshOriginals.length > 0)
			) {
				throw new Error("multiple original relocations would change liveKey");
			}
		};
		const rejectUnverifiedDeleted = async (open: RelocationRow[]) => {
			for (const row of open) {
				if (row.state !== "DELETED") continue;
				if (!exposed.some((item) => item.key === row.oldKey)) continue;
				const verified = await input.store.sha256(row.newKey);
				if (verified !== row.sha256) {
					throw new Error(
						"refusing to purge deleted relocation without a verified copy",
					);
				}
			}
		};
		const pointerKind = async (row: RelocationRow): Promise<RelocationKind> => {
			const currentLive = await input.journal.getLiveKey(input.videoId);
			if (currentLive?.startsWith("private/source/") !== true)
				return kindFor(row);
			const owner = (await input.journal.listForVideo(input.videoId)).find(
				(item) => item.state === "PURGED" && item.newKey === currentLive,
			);
			if (owner && row.id !== owner.id) return "rollback";
			return kindFor(row);
		};
		const initialOpen = await input.journal.listOpen();
		await assertCurrentOpen(initialOpen);
		await rejectUnverifiedDeleted(initialOpen);
		for (const item of exposed) {
			let open = await input.journal.listOpen();
			await assertCurrentOpen(open);
			await rejectUnverifiedDeleted(open);
			let matching = open.filter((row) => row.oldKey === item.key);
			let resumed = matching.length === 1 ? matching[0] : undefined;
			const exists = await input.store.exists(item.key);
			if (!exists && resumed?.state !== "DELETED") continue;
			if (resumed?.state === "DELETED") {
				if (!presigned.has(item.key)) {
					presigned.set(item.key, await input.store.presignGet(item.key));
				}
				if (input.store.presignHead && !headSigned.has(item.key)) {
					headSigned.set(item.key, await input.store.presignHead(item.key));
				}
			}
			open = await input.journal.listOpen();
			await assertCurrentOpen(open);
			await rejectUnverifiedDeleted(open);
			matching = open.filter((row) => row.oldKey === item.key);
			const selected = matching.length === 1 ? matching[0] : undefined;
			if ((resumed?.id ?? null) !== (selected?.id ?? null)) {
				throw new Error(`open relocation video mismatch for ${item.key}`);
			}
			resumed = selected;
			const getUrl = presigned.get(item.key);
			const headUrl = headSigned.get(item.key);
			if (resumed) {
				await continueRelocation(resumed, input.store, input.journal, {
					kind: await pointerKind(resumed),
					preissuedUrl: getUrl,
					probes: headUrl ? [{ url: headUrl, method: "HEAD" }] : undefined,
					crash: input.crash,
				});
			} else {
				const newKey = privateKeyFor(item.kind, input.videoId);
				await relocateKey({
					videoId: input.videoId,
					revisionId: input.revisionId ?? "relocate",
					oldKey: item.key,
					newKey,
					kind: item.kind,
					store: input.store,
					journal: input.journal,
					preissuedUrl: getUrl,
					probes: headUrl ? [{ url: headUrl, method: "HEAD" }] : undefined,
					crash: input.crash,
					flagged: true,
				});
			}
			if (input.store.listVersions) {
				const versions = await input.store.listVersions(item.key);
				if (versions.length > 0) {
					throw new Error(`old key versions remain for ${item.key}`);
				}
			}
			moved.push(item.key);
		}
	}
	const after: Record<string, KeyProbe> = {};
	for (const [key, url] of presigned) {
		after[key] = await probeUrl(input.store, url, headSigned.get(key) ?? url);
		if (!refused(after[key])) {
			throw new Error(`preissued url still readable for ${key}`);
		}
		if (await input.store.exists(key)) {
			throw new Error(`old key still exists after relocation: ${key}`);
		}
	}
	const rows = await input.journal.listForVideo(input.videoId);
	const liveKey = await input.journal.getLiveKey(input.videoId);
	const purged = rows.find(
		(row) =>
			row.state === "PURGED" &&
			row.newKey.startsWith("private/source/") &&
			row.newKey === liveKey,
	);
	if (!purged) {
		throw new Error("relocation no-op is not a successful purge");
	}
	return {
		before,
		after,
		liveKey,
		liveKeyPrivate: liveKey?.startsWith("private/source/") === true,
		idempotent: moved.length === 0,
		moved: moved.length,
	};
}

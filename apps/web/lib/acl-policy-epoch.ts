import { sql } from "drizzle-orm";
import { isInstantFinishEnabledForOwner } from "@/lib/instant-finish-flag";
import { bumpPolicyEpochForVideos } from "@/lib/revision-media-grant";

export type AclExecutor = {
	execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

export const ACL_LOSS_PATHS = [
	"organization-member-removal",
	"invite-decline",
	"space-member-removal",
	"space-member-replacement",
	"space-member-batch-removal",
	"update-space-member-replacement",
	"v1-organization-member-removal",
	"v1-space-member-removal",
	"v1-space-privacy",
	"organization-role-change",
	"space-role-change",
	"domain-restriction-change",
	"shared-video-removal",
	"video-public-change",
	"video-password-change",
	"video-delete",
] as const;

export type AclLossPath = (typeof ACL_LOSS_PATHS)[number];

export type AclScope = {
	organizationId?: string;
	spaceId?: string;
	videoIds?: readonly string[];
};

const ORGANIZATION_PATHS = new Set<AclLossPath>([
	"organization-member-removal",
	"invite-decline",
	"v1-organization-member-removal",
	"organization-role-change",
	"domain-restriction-change",
]);

const SPACE_PATHS = new Set<AclLossPath>([
	"space-member-removal",
	"space-member-replacement",
	"space-member-batch-removal",
	"update-space-member-replacement",
	"v1-space-member-removal",
	"v1-space-privacy",
	"space-role-change",
]);

function queryText(query: unknown): string {
	if (typeof query === "string") return query;
	const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
	if (!chunks) return String(query);
	return chunks
		.map((chunk) => {
			if (typeof chunk === "string") return chunk;
			if (chunk && typeof chunk === "object" && "value" in chunk) {
				const value = (chunk as { value: unknown }).value;
				return Array.isArray(value) ? value.join("") : String(value ?? "");
			}
			return "";
		})
		.join("");
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
	const rows = Array.isArray(result)
		? result
		: ((result as { rows?: unknown[] }).rows ?? []);
	const list = Array.isArray(rows[0]) ? rows[0] : rows;
	return list.filter(
		(row): row is Record<string, unknown> =>
			typeof row === "object" && row !== null && !("affectedRows" in row),
	);
}

export async function withAclChange(
	tx: AclExecutor,
	affectedVideoIds: readonly string[],
): Promise<void> {
	const unique = [...new Set(affectedVideoIds.filter((id) => id.length > 0))];
	if (unique.length === 0) return;
	await bumpPolicyEpochForVideos(unique, tx);
}

export async function videoIdsForSpace(
	tx: AclExecutor,
	spaceId: string,
): Promise<string[]> {
	const result = await tx.execute(sql`
		SELECT videoId FROM space_videos WHERE spaceId = ${spaceId}
	`);
	return rowsOf(result).map((row) => String(row.videoId));
}

export async function videoIdsForOrganization(
	tx: AclExecutor,
	organizationId: string,
): Promise<string[]> {
	const result = await tx.execute(sql`
		SELECT videoId FROM shared_videos WHERE organizationId = ${organizationId}
		UNION
		SELECT sv.videoId AS videoId
		FROM space_videos sv
		INNER JOIN spaces s ON s.id = sv.spaceId
		WHERE s.organizationId = ${organizationId}
	`);
	return [...new Set(rowsOf(result).map((row) => String(row.videoId)))];
}

export async function bumpSpaceAccess(
	tx: AclExecutor,
	spaceId: string,
): Promise<void> {
	await withAclChange(tx, await videoIdsForSpace(tx, spaceId));
}

export async function bumpOrganizationAccess(
	tx: AclExecutor,
	organizationId: string,
): Promise<void> {
	await withAclChange(tx, await videoIdsForOrganization(tx, organizationId));
}

export async function applyLossOfAccess(
	path: AclLossPath,
	tx: AclExecutor,
	scope: AclScope,
): Promise<void> {
	if (ORGANIZATION_PATHS.has(path)) {
		if (!scope.organizationId) {
			throw new Error("organization access change failed closed");
		}
		await bumpOrganizationAccess(tx, scope.organizationId);
		return;
	}
	if (SPACE_PATHS.has(path)) {
		if (!scope.spaceId) throw new Error("space access change failed closed");
		await bumpSpaceAccess(tx, scope.spaceId);
		return;
	}
	await withAclChange(tx, scope.videoIds ?? []);
}

export function refuseFlaggedOwnershipTransfer(input: {
	sourceOwnerId: string;
	targetOwnerId: string;
	env?: NodeJS.ProcessEnv;
}): void {
	const env = input.env;
	if (
		isInstantFinishEnabledForOwner(input.sourceOwnerId, env) ||
		isInstantFinishEnabledForOwner(input.targetOwnerId, env)
	) {
		throw new Error(
			"Ownership transfer is refused while either owner has Instant Finish enabled",
		);
	}
}

export function sqlTextForTest(query: unknown): string {
	return queryText(query);
}

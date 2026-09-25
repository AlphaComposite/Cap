# W-D wire/d-auth

Branch `wire/d-auth` off `a17a3348fa`. No push. No production containers, database, MinIO, nginx, or Beads writes. Playlist route was not edited.

## Built

New:

- `apps/web/lib/revision-media-token.ts` — pure token library. ASCII `base64url(canonical JSON).base64url(HMAC-SHA256)`. Claims `{v:1,videoId,revisionId,publicationEpoch,policyEpoch,iat,exp,grantId}`. TTL 60s, skew 5s, key ring `REVISION_MEDIA_GRANT_KEYS` (or derived from `NEXTAUTH_SECRET`), constant-time verify. Distinct origin service MAC via `REVISION_ORIGIN_SERVICE_SECRET`. `getRevisionPlaybackUrl` puts the grant only in `?t=`.
- `apps/web/lib/revision-media-grant.ts` — `mintRevisionMediaGrant`, `evaluateGrantIssue`, `bumpPolicyEpoch`, `bumpPolicyEpochForVideos`, `bumpPolicyEpochForSpace`, `issueAuthorizedRevisionPlayback`, `denyFlaggedPresign`, `revisionArtifactUrl`, `classifyLiveGrant`. Grant issue uses `VideosPolicy.getViewableById` (password/org/space), not `videos.public`.
- `apps/web/lib/source-relocation.ts` — inventory, INTENT → copy → SHA-256 → pointer → delete all versions → preissued GET/HEAD/Range 4xx → purge. Crash reconcile. Does not mutate `video_edits`.
- `apps/web/lib/private-source-read.ts` — `resolveLiveOriginal`, `mapLegacySourceKey`, `ownerOriginalObjectKey`.
- `apps/web/app/api/media/grant/route.ts` — refresh re-evaluates policy and current publication. `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`. Response does not log the bearer.
- `apps/web/app/api/media/original/route.ts` — owner session only. Streams GET/HEAD/Range from `getObjectResponse`. `private, no-store`. No redirect, no presign.
- `apps/web/lib/instant-finish-flag.ts` — CONTRACT STUB (owned by W-A).
- `packages/web-backend/src/Videos/instantFinishFlag.ts` — same owner-id env check for backend callers.
- `packages/web-backend/src/Videos/policyEpoch.ts` — `bumpPolicyEpochIfFlagged` for `Videos.delete`.
- `apps/web/__tests__/unit/revision-media-auth.test.ts`

Wired so flagged owners mint no direct S3 GET bearer from share playback, download, transcript, OG, thumbnail, preview, mobile playback/thumbnail, `Videos.getDownloadInfo`, `Videos.getThumbnailURL`, and the storage object route. Unflagged S3 storage-object requests still redirect to a presign. Password and v1 password bumps run in the same transaction as the password write. Share, mobile public/password, space/org removal, space password, and space delete bump before the ACL write and throw if the publication table is missing (fail closed).

## Commands

| Command | Exit | Result |
| --- | --- | --- |
| `bun run biome check --write` on touched TS files, then mobile/v1 routes, then the auth test and storage route | 0 | formatted; last storage check fixed 1 file |
| `bun run --cwd apps/web test __tests__/unit/revision-media-auth.test.ts __tests__/unit/share-playback.test.ts` via `systemd-run --user --unit capwire-d-auth-unit2` | 0 | `Test Files 2 passed (2)`, `Tests 16 passed (16)`, duration 1.44s |
| `NODE_OPTIONS=--max-old-space-size=4096 bunx tsc -b packages/web-backend --pretty false --force` | 0 | no diagnostics |
| `bunx tsc -b --pretty false` via `capwire-d-auth-typecheck` | 255 | node OOM (heap limit), memory peak 2.2G. Not a type error. |
| `tsc --noEmit --pretty false --incremental false` in `apps/web` via `capwire-d-auth-tsc-web` | 2 | 12 errors, all `Cannot find name 'PageProps'` or `RouteContext` in files this branch did not edit. Owned files were absent from that error list. `next typegen` was not run. |
| Disposable MinIO `docker compose -p capwire-d-auth -f /srv/styrir/scratch/cap-fzp-8-wire/build-d-auth/compose.yml up -d` | 0 | `127.0.0.1:13010->9000`, `127.0.0.1:13011->9001` |
| `bun /srv/styrir/scratch/cap-fzp-8-wire/build-d-auth/presign-revoke.mjs` | 0 | `{"before":{"GET":200,"HEAD":200,"RANGE":206},"after":{"GET":404,"HEAD":404,"RANGE":404},"remainingVersions":0,"signedUrlLogged":false,"bearerPresentBeforeDelete":true}` |
| `docker compose ... down -v` and `docker stop capwire-d-auth-minio-1` | blocked | single-query mode refused container lifecycle commands. Container `capwire-d-auth-minio-1` was still up on those loopback ports at the end of this run. |

Unit coverage: malformed/forged/skew/expired token; stale policy and non-current revision 410; wrong video 403; refresh after 60s; service MAC is not a viewer grant; allow/password/deny/missing/unflagged/missing-table grant matrix; `denyFlaggedPresign` for raw-preview and `result.mp4`; relocation crash reconcile at intent/copy/pointer/delete; flag-off relocation refused; legacy source key maps to `liveKey`.

Presign evidence is statuses only. The signed URL was not printed.

## Contract stubs

- `apps/web/lib/instant-finish-flag.ts` — CONTRACT STUB (owned by W-A). Integrator replaces it. Keep `INSTANT_FINISH_OWNER_IDS` in sync with `packages/web-backend/src/Videos/instantFinishFlag.ts`.
- No schema or migration files were added. A must reserve this DDL (next free migration after 0046). D readers/writers already use these names and fail closed on `ER_NO_SUCH_TABLE`:

```sql
CREATE TABLE source_object (
  videoId varchar(15) NOT NULL PRIMARY KEY,
  liveKey text NOT NULL,
  sha256 char(64) NOT NULL,
  relocationState varchar(32) NOT NULL
);
CREATE TABLE source_relocation (
  id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  videoId varchar(15) NOT NULL,
  revisionId varchar(128) NOT NULL,
  oldKey text NOT NULL,
  newKey text NOT NULL,
  sha256 char(64) NOT NULL,
  state varchar(32) NOT NULL,
  createdAt timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

`video_publication.policyEpoch` is A's column. D only updates it.

## A / B / C

A: call `bumpPolicyEpoch(videoId)` inside the Finish transaction when publication changes, and `resolveLiveOriginal` / `mapLegacySourceKey` when the rollback renderer reads `video_edits.sourceKey`. Do not write `video_edits` from the publication path. Finish `SourceId` should be the relocated `liveKey`.

B: verify with `verifyRevisionMediaGrant` then `evaluatePresentedGrant` / `classifyLiveGrant` on every GET/HEAD/Range before sending a fragment. 401 malformed/forged/expired/skew, 403 unauthorized, 410 deleted/private/stale policy/non-current. Internal warm/finish uses `signInternalServiceRequest`, not the viewer grant. Read publication/policy epochs live; this branch does not implement the origin.

C: do not presign flagged MP4/raw/segments. Call `denyFlaggedPresign({ ownerId, videoId, key, videoType })` from `app/api/playlist/route.ts` (not edited here). Playback URL comes from `mintRevisionMediaGrant` or `getRevisionPlaybackUrl`. Refresh is `GET /api/media/grant?videoId=`. Pass `?t=` on every child. Do not log the query string.

## Gaps

- Cloudflare cache rules, Edge TTL, purge latency, and `cf-cache-status` were not exercised. No production purge.
- Publication/epoch SQL was not applied to a disposable MySQL. A owns that migration. Missing-table bumps throw `"policy epoch bump failed closed"`; that path was not compose-proven.
- Share, mobile, and space/org ACL bumps are ordered before the write, not one transaction, except video password (web + v1).
- `get-transcript` for a flagged owner returns explicit unavailability instead of stale `transcription.vtt`. R1 captions are exposed as a URL from mobile playback only when `revision_artifact_status` says captions are ready. Origin is not in this worktree, so VTT bytes were not fetched.
- `Videos.getDownloadInfo` and `getThumbnailURL` return none for flagged videos (no presign). The web download action returns owner `/api/media/original` or R1 `download.mp4`, or `"Preparing download..."`.
- `issueAuthorizedRevisionPlayback` does not re-enter `VideosPolicy`; mobile calls `assertMobileVideoAccess` first. The grant route uses `mintRevisionMediaGrant`, which does.
- Google Drive flagged reads stream through the existing Drive `getObjectResponse`. Custom buckets beyond the six webMP4s were not proven.
- Throwaway MinIO container was not torn down. Operator command, when lifecycle commands are allowed: `docker compose -p capwire-d-auth -f /srv/styrir/scratch/cap-fzp-8-wire/build-d-auth/compose.yml down -v`.

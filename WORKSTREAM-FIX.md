# Instant Finish web fixes (wire/fix-web)

Base reviewed: `dc30f6674a`. Local commits only. Origin validation of `rev.generation == pub.currentGeneration` is the other builder's file.

Before: `capfix-web-before2` exit 1. Flagged `local` and `MediaConvert` playlists still presigned. `instant-finish-fix-web.test.ts` failed because `@/lib/acl-policy-epoch` did not exist.

## F2

Changed: `apps/web/lib/acl-policy-epoch.ts:81` `withAclChange`, `:122` `bumpOrganizationAccess`, `:149` `refuseFlaggedOwnershipTransfer`. Called in the same transaction as the ACL write from organization member removal (`remove-member.ts:110`), invite decline (`invite/decline/route.ts:122`), space member removal/replacement/batch (`spaces/[spaceId]/actions.ts:214,289,352`), updateSpace member replacement and public/password (`update-space.ts:127,160`), v1 org role/domain/member removal (`v1/[...route]/route.ts:4646,5061,5376`), v1 space privacy/settings/delete/role/member removal (`:8668,8748,8897,8953`), video delete (`:6853`, `agent-cap-operation.ts:257`), org role (`update-member-role.ts:74`), domain restriction (`update-details.ts:55`), mobile org settings (`mobile/[...route]/route.ts:1176`). Ownership transfer refuses while either owner is flagged (`transfer-organization-content.ts:787`) instead of carrying the publication.

Test: `F2 ACL revocation bumps policy epoch before the next grant use`. Before: module missing, exit 1. After: pass (`capfix-web-after3` exit 0). Each path mints a grant, bumps the epoch, and live classification returns 410 `stale_policy`.

Residual: the test drives the helper with a fake executor. Production call sites are wired, but a newly added ACL write will not bump until it calls the helper.

## F3

Changed: `apps/web/scripts/instant-finish-relocate.ts` inventories exposed keys, copies to a private key, verifies SHA-256, writes `source_object` / `source_relocation`, deletes every version of the old keys, and keeps `private/rollback/` for `result.mp4`. Finish rejects a liveKey that is not the relocated key (`source-relocation.ts:319`, `revision-publication.ts:402`).

Test: disposable MinIO (versioned) + MySQL with migration 0047, project `capfix-web-relocate`, loopback only, torn down. Before relocation GET/HEAD/Range = 200/200/206. After = 404/404/404. Second run did not throw. Crash after copy then reconcile left the pre-issued URL at 404/404/404. Rollback copy retained. liveKey stayed under `private/`.

Residual: proof used a stub `videos` table so 0047 foreign keys could apply. It is not a production bucket run.

## F4

Changed: `apps/web/app/api/playlist/route.ts:193` calls `flaggedPlaylistGate` before any presign. Revision media for flagged mp4/master/video/audio on an mp4 source; every other flagged type returns 404 and does not presign.

Test: `does not presign <source> <type> for a flagged owner`. Before: `local` and `MediaConvert` failed (still presigned). After: those cases pass in the affected suite.

Residual: a flagged mp4 with no publication returns 404 from the revision issuer, not a signed legacy URL. Custom-bucket types that are not an mp4 source are unavailable rather than rewritten.

## F5

Changed: `packages/database/schema.ts:613` and migration `0047_brown_spitfire.sql` add nullable `video_publication.currentGeneration`. The CURRENT flip sets it to the allocated generation in the same update as `currentRevisionId` (`revision-publication.ts:880`). `generation` remains the latest allocated generation.

Test: `keeps R1 playable while R2 is still preparing`. Before: serving helper missing. After: pass. Preparing R2 does not change R1's current generation, so R1 classification stays valid. When R2 is CURRENT, R1 is 410 `stale_publication`.

Residual: the origin must still check `rev.generation == pub.currentGeneration`. That file is not in this worktree.

## F7

Changed: `apps/web/next.config.mjs:130` sets `Referrer-Policy: no-referrer` on `/s/:path*` and `/embed/:path*`. Share and embed documents also emit `<meta name="referrer" content="no-referrer">`. Player logs no longer include `playbackSrc` or the hls `data` object (`HLSVideoPlayer.tsx`).

Test: `sets Referrer-Policy no-referrer on share and embed` and `does not log grant-bearing playback URLs`. Before: player test module missing. After: pass. No PostHog or Sentry calls in the player.

Residual: a future log of `data` or `playbackSrc` would fail the source scan, but other analytics sinks outside the player were not rewired.

## F10

Changed: `packages/database/schema.ts:585` adds `edit_revision.metadataSnapshot`. Finish stores captions, chapters, summary state, and thumbnail (`revision-publication.ts:845`). The owner's pasted summary is copied with `summaryDerived: false`. SSR/DTO reads that snapshot and ignores a later `videos.metadata` write (`revision-publication-read.ts`).

Test: `does not let a later videos.metadata write change R1`. Before: helper missing. After: pass.

Residual: the snapshot is taken from `videos.metadata` at Finish. A summary pasted after Finish is a new revision, not a silent rewrite of R1.

## F12

Changed: `revision-playback.ts:174` `revisionHlsErrorAction` treats 401, 403, 410, and >=500 as refresh, bounds retries, and fails closed on policy denial. The hls.js error branch (`HLSVideoPlayer.tsx:451`) and the Safari native path (`:580`) both use it and load the newly signed playlist URL.

Test: `refreshes on 401 as well as 403, 410, and 5xx` and `replays fake hls events into a bounded refresh then fail-closed`. Before: module missing. After: pass.

E2E still needs to prove playback past 60 seconds and a late seek after the grant rotates.

Residual: the unit test drives the decision function and a fake event replay, not a browser hls.js instance.

## Suites

- Affected vitest (`revision-*`, `segment-playlist*`, `share-playback`, `video-edit*`, `save-video-edits*`, `instant-finish*`): exit 1. 16 files passed, 1 failed, 1 skipped. 203 tests passed, 4 failed, 6 skipped. The 4 failures are `video-edit-processing.test.ts` share-page imports and also fail on `dc30f6674a` without these changes.
- `bunx next typegen`: exit 0.
- `tsc -b apps/web`: exit 0 after the currentGeneration fixture and relocation script type fixes (first run exit 2).
- `python -m unittest discover -s apps/instant-finish-origin/tests`: exit 0, 16 tests.

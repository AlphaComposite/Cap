# W-A revisions, publication fence, server owner flag

Branch `wire/a-revisions` at `/srv/styrir/worktrees/cap-fzp-8-wire-a-revisions`, cut from `downstream/main` `a17a3348fac7e91f3c63ee620826b8a3a2dac041`. Not deployed. Not a production success.

## What landed

- `packages/database/schema.ts` — `edit_intent`, `edit_revision`, `video_publication`, `revision_artifact_status`, `outbox`, plus reserved `source_object` and `source_relocation`.
- `packages/database/migrations/0047_brown_spitfire.sql` and `packages/database/migrations/meta/0047_snapshot.json`, journal idx 47. Columns are camelCase (`videoId`, `currentRevisionId`, `liveKey`) so B's read-only SQL and D's raw SQL match. Uniqueness of `(videoId, generation)` is the `edit_intent` primary key.
- `apps/web/lib/instant-finish-flag.ts` — `CAP_INSTANT_FINISH_OWNERS`, checked by `video.ownerId`.
- `apps/web/lib/revision-publication.ts` — CAS allocate, origin fence, CURRENT flip only after checks, outbox, download lease.
- `apps/web/lib/revision-publication-metadata.ts` — intent hash, caption/chapter/comment clocks, playlist duration, thumbnail binding.
- `apps/web/lib/revision-publication-origin.ts` — internal origin client. Header `x-cap-internal-token`.
- `apps/web/lib/revision-publication-read.ts` — publication DTO, policyEpoch bump, rollback live-key read, editor-open prepare.
- `apps/web/actions/videos/publish-revision.ts` — `publishVideoRevision`, `recordServerEditDraft`.
- `apps/web/actions/videos/save-edits.ts` — flagged `saveVideoEdits` throws and does not start `editVideoWorkflow`. Unflagged path unchanged. Rollback source key reads `source_object.liveKey`.
- `apps/web/app/s/[videoId]/edit/page.tsx` — flagged editor open skips the original S3 presign.
- Tests and disposable compose under `apps/web/__tests__/`.

A publication does not insert `video_uploads`, does not set `metadata.editProcessing`, and does not upsert `video_edits`.

## Commands and exit codes

Disposable compose (not production). Project `capwire-a-revisions`, file `apps/web/__tests__/fixtures/wire-a-revisions.compose.yml`, MySQL `127.0.0.1:13316`, MinIO `127.0.0.1:19010`. Local-only password, not a production secret.

- `bun run db:generate` via systemd unit `capwire-a-revisions-dbgen2`: exit 0. Wrote `migrations/0047_brown_spitfire.sql`.
- Unit: `bunx vitest run __tests__/unit/revision-publication.test.ts __tests__/unit/revision-publication-flag.test.ts __tests__/unit/save-video-edits.test.ts __tests__/unit/video-edit-actions.test.ts` unit `capwire-a-revisions-unit4`: exit 0. `Test Files  4 passed (4)` / `Tests  27 passed (27)`.
- Integration against fresh database `capwire_a` and an in-process fake origin, unit `capwire-a-revisions-integration`: exit 0. `Tests  6 passed (6)`, including migration up, duplicate generation rejection, table drop/recreate, R1 flip, same-intent idempotence, stale generation and same-session draft 409, injected caption 500 blocking CURRENT, fresh revision on retry, stale S0 left SUPERSEDED, Next action 200 only after the fake origin prepared `seg/0.m4s`.
- `bunx biome check --write` on the touched TS/JSON/YML files: exit 0.
- `bunx tsc -b packages/database --pretty false` unit `capwire-a-revisions-tsc-db`: exit 0.
- `bunx next typegen` unit `capwire-a-revisions-typegen`: exit 0.
- `NODE_OPTIONS=--max-old-space-size=5120 bunx tsc -b apps/web --pretty false` unit `capwire-a-revisions-tsc-web`: exit 0.
- Earlier `tsc --noEmit` without project builds exited 2 (`TS6305` missing `dist`). Earlier `tsc -b apps/web` before `next typegen` exited 1 with 12 pre-existing `PageProps` / `RouteContext` errors, none in W-A files. A full `tsc -b` without a raised heap was killed by the default Node heap limit (not a type error).
- `curl -fsS http://127.0.0.1:19010/minio/health/live`: HTTP 200. Fence tests did not write MinIO objects.

## Contract stubs (integrator replaces these files)

- `apps/web/lib/revision-media-grant.ts` — `CONTRACT STUB (owned by W-D)`. Exports `ownerOriginalPath(videoId)` as `/api/media/original?videoId=...`, matching W-D's current helper. Editor open calls this. It must not become an S3 presign.
- `apps/web/lib/private-source-read.ts` — `CONTRACT STUB (owned by W-D)`. Exports `resolveLiveOriginal`, `mapLegacySourceKey`, `ownerOriginalObjectKey`. A does not call this module. A reads `source_object.liveKey` via `resolveRollbackSourceKey`.
- `apps/web/lib/source-relocation.ts` — `CONTRACT STUB (owned by W-D)`. `resolveLegacySourceKey` is a minimal stand-in. `relocateKey` throws. D owns copy/verify/delete and the journal writer.

## Handoff

B internal routes, authenticated with `x-cap-internal-token`:

- `POST /internal/sources/{videoId}/prepare` on editor open. Return `sourceKey`, `sha256`, `codec`, `timebase`, `frameMode`, `a1Digest`, `indexId`, `warmExpiresAt`.
- `POST /internal/revisions/{revisionId}/prepare`. Return `decoded`, `decodedFrames`, `initSha256`, `seg0Sha256`, `playlistDurationSeconds`.
- `GET` and `HEAD /media/{videoId}/r/{revisionId}/{init.mp4,seg/0.m4s,playlist.m3u8,captions.vtt,chapters.json,thumbnail.jpg}`.
- Env: `CAP_INSTANT_FINISH_ORIGIN_URL`, `CAP_INSTANT_FINISH_INTERNAL_TOKEN`, `CAP_INSTANT_FINISH_OWNERS`.

C: call `publishVideoRevision` with the committed V2 spec, `baseGeneration`, `draftVersion`, `draftSession`, and wait for `{success:true,revisionId,generation}`. Call `recordServerEditDraft` for the server draft. A localStorage-only draft is not enough. Read `getInstantFinishPublicationDto`: `{enabled,currentRevisionId,generation,duration,revisionMetadata}`. Do not edit `EditVideoClient` from this branch; it is not wired to Finish.

D: replace the three stubs. Bump privacy with `bumpPublicationPolicyEpoch`. Rollback source key is `resolveRollbackSourceKey`. Publication columns are camelCase. `download.mp4` is an outbox job plus `claimArtifactLease` / `markArtifactFailed`, not part of the 200 fence.

Summary text is persisted and not auto-derived (`summaryDerived: false`). Comments inside removed ranges are set to null at publish time. Flag off keeps `saveVideoEdits` -> `editVideoWorkflow`.

## Gaps

- `restoreVideoToOriginal` resolves the live key but is not refused when the owner flag is on. It can still start the existing rollback renderer.
- Editor-open `POST /internal/sources/{videoId}/prepare` is implemented and not exercised by the disposable integration test. That fake origin only implements revision prepare and media readback.
- Concurrent Finish was one MySQL transaction interrupted by a newer generation (`onAllocated`), not two OS processes.
- Disposable compose is still up. `docker compose -p capwire-a-revisions ... down -v` was refused by the command filter in this session. Do not confuse it with `cap-web` / `cap-mysql` / `cap-minio`. Tear it down before leaving the host:

```
docker compose -p capwire-a-revisions -f /srv/styrir/worktrees/cap-fzp-8-wire-a-revisions/apps/web/__tests__/fixtures/wire-a-revisions.compose.yml down -v
```

- No production containers, production MySQL, production MinIO, nginx, or Beads writes.

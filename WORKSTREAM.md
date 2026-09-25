# cap-fzp.8 wire integration

Branch `wire/integration` in `/srv/styrir/worktrees/cap-fzp-8-wire-integration`. Base `a17a3348fa`. Not pushed. Not production. Not the section 9 acceptance run.

The previous text in this file was W-A's handoff, kept on every merge. This replaces it with the integration result.

## Merge

Order A, B, D, C, each `--no-ff`. Shared modules kept the owner's implementation.

- `1c8daba9a3` merge `wire/a-revisions` (`677f50bac5`): schema 0047, owner flag, publication fence, origin client.
- `fa60dfe251` merge `wire/b-origin` (`85a502519f`): origin service, nginx location, PyAV. Kept A's `apps/web/lib/revision-publication.ts`.
- `ab54060864` merge `wire/d-auth` (`da08a3d9b9`): grant, token, relocation, private source reads. Kept A's owner flag.
- `15fe926287` merge `wire/c-player` (`3f906db8af`): player, seek helper, Done wiring. Kept A/D shared modules.
- `ba20e01125` reconcile the ten contracts.
- `466512f8f6` `b702ba5695` `e35c872bc1` fence test and typecheck fixes.

C's `CONTRACT STUB` modules were replaced by A/D implementations during the merges. No stub-only export remains as the live implementation of those modules.

## Mismatches

1. Owner flag. Canonical env `CAP_INSTANT_FINISH_OWNERS`, parser `packages/utils/src/instant-finish-flag.ts:1`. Re-exported by `apps/web/lib/instant-finish-flag.ts:1` and `packages/web-backend/src/Videos/instantFinishFlag.ts:1`. Callers and tests no longer read `CAP_INSTANT_FINISH_OWNER_IDS` or `INSTANT_FINISH_OWNER_IDS`.

2. Internal service auth. Canonical header `x-cap-origin-service` (`apps/web/lib/revision-media-token.ts:10`). MAC is method + path + body sha256 + timestamp, skew 5s, TTL 30s (`revision-media-token.ts:273`, `apps/instant-finish-origin/service_auth.py:10`). Secret `REVISION_ORIGIN_SERVICE_SECRET`, at least 32 bytes, distinct from the grant secret. A's client sends it (`apps/web/lib/revision-publication-origin.ts:84`). B verifies it case-insensitively (`apps/instant-finish-origin/server.py:93`). No `x-cap-internal-token` and no `X-Origin-Service-Token` on the live path.

3. Viewer grant. Canonical ring `REVISION_MEDIA_GRANT_KEYS` (`revision-media-token.ts:84`, `apps/instant-finish-origin/grant.py:83`, `server.py:637`). Token is `kid.base64url(canonical JSON).base64url(HMAC)`. No derivation from `NEXTAUTH_SECRET`. Unset ring fails closed in `server.py:637`. The `ORIGIN_GRANT_SECRET` fallback was removed.

4. Publish action. Canonical `publishVideoRevision` in `apps/web/actions/videos/publish-revision.ts:72`. Done records the server draft first (`apps/web/app/s/[videoId]/edit/EditVideoClient.tsx:1142`) then publishes (`EditVideoClient.tsx:1147`). Flag-off still calls `saveVideoEdits` (`EditVideoClient.tsx:1135`).

5. Publication DTO. One type, `InstantFinishPublicationDto` at `apps/web/lib/revision-publication-read.ts:35`, including `draftVersion`, `draftSession`, and `revisionMetadata.duration/chapters/captionsAvailable/commentTimestamps/thumbnailAvailable/downloadReady`. Re-exported from `revision-publication.ts` as `RevisionPublicationDto`. The player reads that type (`apps/web/lib/revision-playback.ts`).

6. Policy epoch. Canonical `bumpPolicyEpoch` / `ForVideos` / `ForSpace` in `apps/web/lib/revision-media-grant.ts:119`. Finish calls it inside the flip transaction (`revision-publication.ts:850`). ACL bumps are in the same transaction as the write: `apps/web/actions/caps/share.ts:75`, `apps/web/actions/organization/update-space.ts:121`, `apps/web/actions/spaces/remove-videos.ts:52`, `apps/web/actions/organization/delete-space.ts:66`, `apps/web/actions/organizations/remove-videos.ts:84`, and the mobile sharing and password handlers in `apps/web/app/api/mobile/[...route]/route.ts`. Password (`apps/web/actions/videos/password.ts:38`) and the v1 password route (`apps/web/app/api/v1/[...route]/route.ts:7449`) were already transactional.

7. Origin prepare. Superset is implemented in `apps/instant-finish-origin/server.py` source prepare (`server.py:145`) and revision prepare (`server.py:194`). The client consumes it in `revision-publication-origin.ts`. The fence refuses CURRENT unless `seg0DecodedFrames >= 1`, `playlistHasEndList`, and `intentId` match (`revision-publication.ts:542`).

8. Grant refresh. POST only, JSON body, grant returned in the JSON body, no GET (`apps/web/app/api/media/grant/route.ts:18`). The player posts JSON (`apps/web/app/s/[videoId]/_components/HLSVideoPlayer.tsx:224`).

9. Restore. `restoreVideoToOriginal` throws when the owner flag is on (`apps/web/actions/videos/save-edits.ts:382`).

10. Origin CPU. `docker-compose.yml:92` is `cpus: "${ORIGIN_CPUS:-2}"`. The integration smoke at 8 was not run.

## Tests run

Origin pytest, second run after the case-insensitive MAC header fix:

`systemd-run --user --unit capwire-int-pytest --collect --wait -p MemoryMax=8G -p CPUQuota=400% -p WorkingDirectory=/srv/styrir/worktrees/cap-fzp-8-wire-integration /srv/styrir/scratch/cap-fzp-8-wire/build-b-origin/venv/bin/python -m unittest discover -s apps/instant-finish-origin/tests -v`

Exit 0. `Ran 16 tests in 8.725s` / `OK`. The first run exited 1: five media tests got HTTP 401 because urllib capitalizes `x-cap-origin-service`.

Web unit, `bunx vitest run` under units `capwire-int-vitest` and `capwire-int-vitest2`, working directory `apps/web`:

- `revision-media-auth.test.ts` 10 passed
- `revision-player.test.ts` 15 passed
- `segment-playlist-route.test.ts` 26 passed
- `revision-publication-flag.test.ts` 2 passed
- `revision-publication.test.ts` 5 passed, 6 skipped (those need MySQL; they ran in the fence file)
- `video-edit-actions.test.ts` 15 passed, exit 0

Fence integration against disposable MySQL `capwire-int-mysql-1` on `127.0.0.1:31416`, database `capwire`, project `capwire-int`:

`bunx vitest run __tests__/unit/revision-publication.integration.test.ts`

Exit 0. `Test Files  1 passed (1)` / `Tests  6 passed (6)`. Covers migration 0047 up/down, R1 only after the fence, 409 stale generation, metadata failure retry, stale S0, and the Next action against the fake origin using the signed MAC.

Typecheck, unit `capwire-int-typecheck`:

`cd apps/web && bunx next typegen` then `NODE_OPTIONS=--max-old-space-size=5120 bunx tsc -b apps/web --pretty false`

First `tsc` exited 2 (three errors). After the grant narrowing and done-plan type fix, `tsc` exited 0.

## E2E

Not run. No Playwright Chromium or WebKit session. No screenshots in `/srv/styrir/scratch/cap-fzp-8-wire/build-integration/evidence/`. No click-to-first-frame timings. No HTTP statuses for share, embed, grant 403, or privacy 410. The gate fixture and production video `z9x58adx1ra8bm3` were not copied into disposable MinIO. The origin container, nginx, and Next.js were not started. The `ORIGIN_CPUS=8` smoke was not run.

Disposable MySQL only:

- project `capwire-int`
- compose `/srv/styrir/scratch/cap-fzp-8-wire/build-integration/compose.yml`
- container `capwire-int-mysql-1` on `127.0.0.1:31416`
- production containers were not touched

Teardown was not run from this session. Exact command:

`docker compose -p capwire-int -f /srv/styrir/scratch/cap-fzp-8-wire/build-integration/compose.yml down -v`

W-A's older disposable project may still be up from that builder. Its teardown, also not run here:

`docker compose -p capwire-a-revisions -f /srv/styrir/worktrees/cap-fzp-8-wire-a-revisions/apps/web/__tests__/fixtures/wire-a-revisions.compose.yml down -v`

## Known gaps

- Browser proof of Instant Finish (editor Done, HLS through nginx, D6 seek, embed, viewer 403, mid-play 410, raw-preview deny, flag-off legacy invoke) is unproven.
- The real production source was not copied.
- The origin image was not built in this session.
- The `ORIGIN_CPUS=8` comparison smoke was not run.

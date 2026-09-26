# Instant Finish web latency

Branch `wire/perf-web`. Base `c47460a891`. Commits `c184b22424`, `7e642abb5e`, `9e56f6a367`. Ownership is `apps/web` and `packages` only. Origin attestation emission is the parallel builder. This tree verifies that contract; it does not emit it.

Before numbers are the scout's five cold Chromium Dones on `capwire-e2e` (`/srv/styrir/scratch/cap-fzp-8-wire/scout-f-latency/findings.md`). That probe did not paint a frame: the share video did not autoplay, so the lower bound is seg0 response end. E2E rVFC from `WORKSTREAM-E2E.md` is a single slower run, not a p95.

| source | browser | before p50 | before p95 / max | after |
| --- | --- | --- | --- | --- |
| z9 | chromium | url 1530 ms; seg0 end ~1740 ms | url max 1602; seg0 end max 1803 | not remeasured |
| z9 | webkit | E2E rVFC 1550 ms (one run) | not in the scout sample | not remeasured |
| fixture | chromium | url 1595 ms; seg0 end ~1837 ms | url max 1686; seg0 end max 1964 | not remeasured |
| fixture | webkit | E2E rVFC 2087 ms (one run) | not in the scout sample | not remeasured |

A disposable media stack with five cold Dones per source in Chromium and WebKit was not stood up. `capwire-e2e` was left running and was not modified. Origin in this tree does not yet send `x-cap-origin-attestation`, so a Done against this tree's origin fails closed. Browser p50/p95 after these changes are unknown. Do not treat the scout estimate (0.9-1.2 s) as a measurement.

## Changes

1. Playback payload, one action, no second refresh.
   - `apps/web/actions/videos/publish-revision.ts:108` calls `recordServerDraft` then publish, then `:137` one `revalidatePath`, then `:138` `loadPublishPlayback`.
   - The grant is `mintRevisionMediaGrant` after `getInstantFinishPublicationDto` confirms the flipped revision (`:90-97`). That is the same VideosPolicy plus current-publication read as share SSR.
   - `apps/web/app/s/[videoId]/edit/EditVideoClient.tsx:1145` no longer calls `recordServerEditDraft` or `router.refresh`. `:1155` stashes the payload in sessionStorage keyed by revision id. `:1169` pushes `/s/{videoId}`.
   - `apps/web/lib/instant-finish-playback-handoff.ts:65` prefers the stash only when it matches the SSR revision, is unexpired, and carries a grant. Otherwise SSR.
   - `apps/web/app/s/[videoId]/Share.tsx:308` applies that before paint. `:1037` drops the processing overlay when playback exists. `:995` forces muted autoplay only for a handoff arrival.
   - Test: `apps/web/__tests__/unit/instant-finish-playback-handoff.test.ts`. Passes. Fails if the stash is expired, for another revision, or written into the URL.

2. Serial post-prepare reads leave the Done path.
   - `apps/web/lib/revision-publication.ts:537` `produceAndVerify` no longer HEAD/GETs init, seg0, playlist, captions, chapters, or thumbnail.
   - `:1084` `parseVerifiedOriginAttestation` requires a MAC over the raw prepare body, seg0 decoded frames, endlist, intent id, and duration. A missing or forged MAC does not flip CURRENT.
   - The MAC is HMAC-SHA256 of those exact bytes, base64url, `REVISION_ORIGIN_SERVICE_SECRET`. Verified against `apps/web/__tests__/unit/fixtures/origin-attestation.json` (same vector as the origin builder). Re-serializing the body fails verification.
   - `:166` queues readback after the flip. `:1255` on failure logs `cap-revision-readback-failed`, marks the revision FAILED, and points CURRENT back at the previous revision.
   - `apps/web/lib/revision-publication-metadata.ts:36` adds the `readback` outbox job.
   - Test: `revision-origin-attestation.test.ts` and `revision-publication.integration.test.ts` "flips on a signed attestation, then reverts CURRENT when async readback fails". That test saw `artifactReads === 0` before the flip, then the alert `captions.vtt resolved 500`, then CURRENT restored and the revision `FAILED`.

3. One revalidatePath.
   - `publish-revision.ts:137` only. The previous second call on the same path is gone.

4. Player clock.
   - `apps/web/lib/revision-seek.ts:97` starts a poll after setting `currentTime`.
   - `apps/web/lib/revision-seek-clock.ts:35` samples until `seeked` or 8 frames, even if the element never emits `timeupdate` or `seeked`.
   - `playback-store.ts:143` and `media-player.tsx:2631` subscribe, and `:2677` renders `shownTime`.
   - Test: `revision-seek-clock.test.ts` with a fake element that throws if it emits media events. Passes.

## Gates

- `apps/web` vitest on `revision-*`, `segment-playlist*`, `share-playback*`, `video-edit*`, `save-video-edits*`, `instant-finish*`: 21 files, 218 passed, 0 failed. Includes the fence tests against disposable MySQL `capperf-web` on `127.0.0.1:35116`.
- `bun test apps/instant-finish-origin/tests/grant-vectors.test.ts`: 19 passed. Origin sources in this tree are unchanged, so the image was not rebuilt and origin unittest was not re-run.
- `tsc -b apps/web` reports 234 errors, all under `../cap-fzp-8-wire-integration/packages/**` because this worktree's `node_modules` is a symlink into that tree. No error path is in this worktree.

## Residual

- Browser Done p50/p95, both sources, both browsers, with a painted rVFC frame: not measured.
- Section 9 (1.5 s p95) is not claimed.
- A Done against this tree's origin fails until the origin builder sends `x-cap-origin-attestation` over the raw prepare body.
- Handoff still waits for the share RSC to confirm the revision. It removes the draft action, the serial origin reads, and `router.refresh`. It does not skip SSR.
- WebKit's gapped SourceBuffer on z9 is unchanged. The clock follows `currentTime`; it does not make a stalled seek land.

Teardown for the disposable MySQL:

```
docker compose -p capperf-web -f /srv/styrir/scratch/cap-fzp-8-wire/capperf-web/compose.yml down -v
```

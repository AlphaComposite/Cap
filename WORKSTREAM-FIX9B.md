# WORKSTREAM-FIX9B

Builder: grok-4.7. Bead: cap-fzp.8.7.30. Base: ed7338557a. Branch: wire/integration. No push. No production.

## Bug

Share Transcript tab stayed on "No transcript available" after Done. `sidebarData` set `transcriptionStatus: playback ? null : transcriptionStatus`, so `useTranscript` never enabled and `getTranscript` was never called. Captions file was already correct (fix9).

## Why it was nulled

The null was introduced in 3f906db8afc (`revisionPlayback ? null`) and only renamed to `playback` in 7e642abb5e. That commit's test (`instant-finish-playback-handoff.test.ts`) checks stash vs SSR playlist, not transcription status. What 7e642abb5e protects, and this change leaves in place:

- `shareVideoData` still nulls status when playback is set. ShareVideo uses that for `useTranscript`, the COMPLETE-gated subtitle blob, `hasCaptions`, and the live-transcript fallback. Null keeps the player on the revision `captionsUrl` / playlist track and stops a status poll from painting the source transcript over a ready revision.
- `isEditProcessing={playback ? false : isEditProcessing}` is unchanged. The new unit test still expects the player to receive `isEditProcessing=false` when a revision playback is set.

The Transcript tab reads `sidebarData`, not `shareVideoData`. `shareVideoData` was left null on purpose.

## Fix

`apps/web/app/s/[videoId]/Share.tsx`: `sidebarData.transcriptionStatus` is the real status.

Summary `canEdit` is `isOwner && status !== "PROCESSING"`. For a Done owner (`COMPLETE`), null and `COMPLETE` both allow edit. The under-player paste button already used the local real status, not `sidebarData`. A revision that is still `PROCESSING` would newly block rail edit, matching the non-revision page. Not special-cased.

## Failing-before

At ed7338557a, `revision-sidebar-transcript-status.test.ts`: `expected null to be 'COMPLETE'` on the sidebar prop. EXIT 1.

## Gates

- New test after the fix: pass. Sidebar `COMPLETE`, player status still null, edit-processing overlay still forced off.
- Gated vitest glob: 37 files passed, 1 skipped (`revision-publication.integration.test.ts`, no `DATABASE_URL`), 246 passed, 26 skipped. The 271 baseline included those 26 integration tests against disposable MySQL. Unit count is the prior unit set plus this test.
- `NODE_OPTIONS=--max-old-space-size=6144 ./node_modules/.bin/tsc -b apps/web`: TSC 0.

## Runtime

Web only. `next build --turbopack` with `build-e2e/web.env` via systemd EnvironmentFile. Compiled in 9.2s. BUILD_ID `fWJjzDWC70iHbCgDJgdCN`. Recreated `capwire-e2e-web-1` only. Origin untouched (started 18:01Z, healthy, NanoCpus 2000000000). Production `cap-web` not touched. Probe: web 307.

Evidence: `/srv/styrir/scratch/cap-fzp-8-wire/build-e2e/evidence-fix9b/e2e`.

`score-row12.py` (not modified):

- chromium: cueCount 1216, captionKeptPresent 1055/1055, captionCutLeaked 0, panelKeptPresent 0, panelCutLeaked 0, pass false
- webkit: same numbers, pass false

The Transcript tab is not empty. Both screenshots (`fixture-chromium-12.png`, `fixture-webkit-12.png`) show the Transcript tab selected, no "No transcript available", and a list of revision words (`w138`, `w148`, `w167`, ... `w279`). The harness writes the shortest matching node, which is one cue: `00:00\nw138`. That word straddles a keep boundary, so the scorer's fully-inside count is 0. On-screen kept words the file did not save include `w210` and `w261`. e2e.mjs, the seed, and the scorer were not edited.

Rows 1-6: chromium all pass. Webkit 1, 2, 3, 5, 6 pass. Webkit row 4 fail: late seek stallMs 15018, landed at 47.7s instead of the late target. Not this diff (sidebar status only). Not retried.

## Noticed, not fixed

- Row 12 numeric fail is the shortest-node panel capture, not an empty tab. Left the harness alone as instructed.
- Fixture webkit row 4 late seek timed out at 15s. Chromium row 4 late seek was 70ms.
- `shareVideoData` still nulls transcription status. Player captions stay on the playlist track.
- Share page still shows "Preparing" and "No summary yet." Those paths were not changed.
- Gated integration file skipped here (no disposable MySQL).

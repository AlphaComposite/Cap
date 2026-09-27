# WORKSTREAM-FIX4

Continuation of cap-fzp.8.7.15 (duration-check 500), cap-fzp.8.7.1 (Done to first NEW frame <= 1.5 s p95), and cap-fzp.8.7.13 (playback beyond the 60 s grant).

Worktree `/srv/styrir/worktrees/cap-fzp-8-wire-integration`, branch `wire/integration`. Not pushed. Production containers, `/srv/styrir/apps/cap`, `/etc`, and other worktrees were not touched.

## Commits

- `8e0f4e1382` fix: attest snapped holds and join a matching prepare (inherited; gates were not recorded, rerun below)
- `2301b192c1` style: format the snapped-duration check (inherited)
- `af5cebfbe0` fix: resume a refreshed grant from the current position
- `0093b74cfd` fix: keep prepare chapters bytes for readback
- `5cb2516cff` fix: resume a grant refresh from the last positive time
- `0c8385f7f5` fix: keep the resume time across a grant-refresh remount

HEAD at the end of this run: `0c8385f7f5`.

## What changed

F1. Inherited. Origin attestation v2 MACs per-range `firstPts` / `lastPts` / `lastDur`, `durationTicks`, `timescale`, and `maxHoldTicks`. Web `assertSignedPrepareAttestation` and `readPlaylist` use `snappedDurationError`: start gap under one attested max hold, end inside the last included frame, total within 1 tick. The playlist-vs-origin 0.05 s check remains. The `max(0.05, n/24)` spec comparison is gone. `finishMetadataSnapshot` stores the attested playlist duration. Share metadata prefers that revision duration.

F2. Inherited. Done joins an in-flight prepare for the same spec and still aborts a different spec. Prepare starts on Done pointerdown when none is in flight or ready. A late prepare response cannot overwrite state after Done (`acceptSettledPrepare` plus `savingRef`). Join still verifies the MAC before flip.

F2(c). Kept `SETTLE_PREPARE_DEBOUNCE_MS` at 150. Not reverted to 400. A burst of 8 trim drags, 180 ms apart, on z9/Chromium produced 8 prepare POSTs during the burst (1 per settled drag, not 1 per mousemove) plus 1 prepare from editor open. Origin CPU samples: 0.51, 0.42, 65.36, 42.15, 31.00, 31.52, 38.01, 29.46, 44.19, 38.70, 0.47 percent. Peak 65 percent of one core, back under 1 percent after the burst. The 2 CPU quota was not saturated. Evidence: journal `capf4-burst2`.

F3. `measure4.mjs` is a copy of `measure.mjs`. The original was not edited. Scored clock is still rVFC `mediaTime > 0` on the new revision. It records `playing-positive` and `rvfcMinusPlaying`. Seg0 GETs count only from dispatch to the paint mark. The page pauses playback and closes the context immediately after the row is recorded. MySQL password is passed as `docker exec -e MYSQL_PWD` from `secrets.env` (not on argv, not printed). The container mysql binary was not modified; `/usr/bin/mysql` is the image binary and `/usr/bin/mysql.real` is absent.

F4. Inherited refresh-on-401 still called `startLoad(resumeAt)` before hls.js had levels. `checkAutostartLoad` then calls `startLoad(config.startPosition)`, which defaults to -1, so the resume restarted at segment 0. `af5cebfbe0` sets `hls.config.startPosition` before `loadSource`, seeks if the element is still more than 1 s off, and coalesces a 401 burst so two in-flight fragment errors cannot burn the retry budget. 403/410 still pause and destroy. Native WebKit pauses, seeks on `loadedmetadata`, then plays.

## Failing-before / passing-after

Failing-before, from `3b4ee10af8` (evidence-fix4/failing-before.json): the old `max(0.05, n/24)` check rejected all 8 scout rows (overhang 0.053 to 0.134 s). Old Done fence always aborted the in-flight prepare. Debounce was 400 ms. Old player called `startLoad` without setting `config.startPosition`.

Passing-after, current tree (evidence-fix4/passing-after.json):

- `{0, 5.641}` lastPts 5.633333 lastDur 0.141667 total 5.775 accepted (`snappedDurationError` null).
- Same request with an extra frame (lastPts 5.775, total 5.908333) rejected: end outside `(5.775, 5.908333]`.
- All 8 scout rows accepted by the web predicate.
- Origin image unittest on `capwire-e2e-origin` (matches HEAD Python): 42 tests, 0 failures, 0 skipped. That suite includes `test_scout_hold_snaps_exclude_the_next_frame` (the 8 ends, next frame at 5.776 is 90752 ticks) and the frame oracle `11444224` ticks. A/V MAX_ADJUST was not changed.
- Player source sets `hls.config.startPosition` before `hls.startLoad(startPosition)`. Join abort is skipped when `joinOnDoneRef` is set. Debounce constant is 150.

## Gates

- vitest `revision-*` `save-video-edits*` `video-edit*` `instant-finish*` `fix2*` `source-relocation*` `seg0-inflight*` `editor-publish-unmount*` `revision-route-guard*` `revision-thumbnail*` `origin-object-policy*` plus the new player/attestation tests: 30 files, 230 tests, passed. Unit `capf4-vitest-gate`, 2026-09-27 06:39:43.
- Disposable MySQL integration on `capf4-mysql` loopback port 36136, database `capf4`, not skipped: 18 passed. Unit `capf4-integration`. Container and its volume were removed after the gates.
- Origin unittest, image `capwire-e2e-origin` built from this worktree, file hashes of `lib_origin.py`, `server.py`, and `lib_audio.py` match HEAD: 42 passed. Unit `capf4-origin-test`.
- `next typegen`: types generated, no git diff. Unit `capf4-typegen`.
- `tsc -b apps/web` with `NODE_OPTIONS=--max-old-space-size=6144`: exit 0. Unit `capf4-tsc`.
- biome check on the four changed TS/TSX files: clean, no fixes.

## Stack

`capwire-e2e` left running. Web container recreated after `next build --turbopack` (BUILD_ID `o-jSwk7uDhW914uobR8OE`, written 06:39:27) so `next start` loaded the finished build. Started 2026-09-27T04:44:25Z. Origin NanoCpus 2000000000. Web listens through nginx on 127.0.0.1:32120. MinIO root credentials in the running container did not match `secrets.env`; `web.env` `CAP_AWS_*` was aligned to the live MinIO user before the burst probe. Values are not recorded here.

Host load at the timed-run start: `0.31, 0.67, 0.63`.

z9's published keep range had been consumed to 0-1.684 by earlier runs. Before this timed run it was widened to 0-40 in the e2e `edit_intent` row only (`sourceDuration` left at 142.933). Auto-cut ranges do not overlap 0-40.

## Timed run

First attempt (unit `capf4-measure`, evidence moved to `evidence-fix4/timed-before-chapters-fix/`) was discarded. Readback compared `chapters.json` to a document rebuilt with the snapped duration, failed closed (`chapters.json resolved 200`), and reverted the publication. WebKit then saw 410 before rVFC. Fixed in `0093b74cfd`. Web rebuilt and the container recreated. Host load at the rerun start: `1.41, 1.84, 1.26`.

Scored clock unchanged: dispatch to share rVFC `mediaTime > 0` on the new revision. Rank `ceil(p/100*n)-1` on finite painted values. Bar 1500 ms p95, immediate only. n=10.

| cell | painted raw ms | p50 | p95 | nulls | 500 | 409 | publishMs | preparePosts | seg0 GETs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| immediate fixture/chromium | 943, 1019, 931, 959, 868, 887, 929, 905, 1050, 904 | 929 | 1050 | 0 | 0 | 0 | 224-387 | 1 | 1 |
| immediate fixture/webkit | 1679, null, 1775, 2014, 1877, 2016, 1753, 2169, 1701, 1920 | 1877 | 2169 | 1 | 0 | 1 | 78-344 | 1-3 | 0-1 |
| immediate z9/chromium | 795, 2525, 1788, 1805, 1419, 1479, 1575, 1475, 1454, 1410 | 1475 | 2525 | 0 | 0 | 0 | 215-1012 | 1-2 | 1 |
| immediate z9/webkit | 1548, 1658, 1602, 1657, 1633, 1714, 1602, 1719, 2736, 1921 | 1657 | 2736 | 0 | 0 | 0 | 507-898 | 1-2 | 1 |
| settled fixture/chromium | 733, 730, 689, 677, 651, 612, 632, 664, 606, 743 | 664 | 743 | 0 | 0 | 0 | 40-76 | 1 | 1 |

Settled fixture/chromium publishMs 40-76 shows the join path is warm when the prepare finished before Done. Immediate z9 publishMs 500-1000 is the origin prepare still inside the scored window: the harness clicks 50 ms after mouseup, and the 150 ms debounce has not fired, so pointerdown starts the prepare only as the click begins.

| settled fixture/webkit | 1259, 1202, 1107, 1115, 1131, 1090, 1109, 1133, 996, 961 | 1109 | 1259 | 0 | 0 | 0 | 62-95 | 1 | 1 |
| settled z9/chromium | 893, 816, 873, 855, 880, 882, 713, 931, 740, 782 | 855 | 931 | 0 | 0 | 0 | 55-202 | 1 | 1 |
| settled z9/webkit | 1411, 1208, 1097, 1104, 1091, 928, 1240, 1305, 1184, 1388 | 1184 | 1411 | 0 | 0 | 0 | 59-294 | 1 | 1 |

Immediate p95 is over 1500 ms except fixture/chromium (1050). Settled cells are informational and all under 1500. Evidence: `evidence-fix4/timed/`.

The first duration-z9-chromium cell (20) ran after the keep range had been cut to 0.05 s. It recorded 2 HTTP 500s (`illegal transition FAILED -> READY`, and a generic `Revision request failed`). Neither toast was a snapped-duration mismatch. WebKit's first 20-run cell aborted because the trim handle was gone. z9 was widened back to 0-40 and the 20-run cells were rerun into `evidence-fix4/duration-rerun/`.

Rerun, 20 immediate z9 Dones per engine:

- Chromium: 1 HTTP 500 (`Revision request failed`, StorageError). No snapped-duration toast.
- WebKit: 3 HTTP 500s (2 `illegal transition from FAILED to READY`, 1 generic). No snapped-duration toast.

Duration-check 500s: 0 of 40. Other HTTP 500s: 4 of 40. Those are not the 8.7.15 duration mismatch.

## F4 playback

First run (before the resume fix) dropped from about 78 s to 0 after one 401 and loaded a late seg/0. Evidence: `playback-before-resume-fix/`.

Final run on `0c8385f7f5`, fixture output duration 662.6 s (uncut is 1037 s, not used), wall 185 s, seek +30 s after 90 s wall:

| engine | endTime | seek | 401 | seg0 after 15 s | stalls > 2 s | drops | uncut | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chromium 1228 | 150.5 | 78.5 -> 108.5 | 2 | 0 | 0 | 0 | no | yes |
| WebKit 2311 | 200.6 | 98.9 -> 128.9 | 2 | 0 | 0 | 0 | no | yes |

Evidence: `evidence-fix4/playback/chromium.json` and `webkit.json`. Screenshots `fixture-chromium.png`, `fixture-webkit.png`.

## 11-row E2E

Evidence: `evidence-fix4/e2e/`. Chromium 1228 and WebKit 2311. Origin quota restored to 2 (`NanoCpus 2000000000`) after row 11.

| Row | What | Result |
| --- | --- | --- |
| 1 | editor open, Done enabled | PASS fixture/z9 x chromium/webkit |
| 2 | Done to share, no Processing | PASS all four |
| 3 | origin-only playlist | PASS all four |
| 4 | seeks | PASS all four |
| 5 | reload and embed | PASS all four |
| 6 | clock | PASS all four |
| 7 | privacy via UI | PASS all four. Grant 403, segment 410, password play, audience restored |
| 8 | origin-only aliases | PASS (`row8.json`) |
| 9 | rollback on clean fixture | FAIL |
| 10 | second edit replaces first | PASS. Old playlist 410. click-to-share 5711 ms |
| 11 | same at origin quota 8 | PASS. NanoCpus 8000000000, then restored to 2000000000. Old playlist 410. click-to-share 5761 ms |

Row 9: `extra.mjs 9` waited 180 s and did not leave the editor. The publish POST returned 500. Web logs showed `InvalidAccessKeyId` from the web S3 client. The mysql and minio containers have empty root-password env vars, so the stock seed could not authenticate until it used `MYSQL_PWD` and a working mc alias. The object uploaded. The web `CAP_AWS_*` key is still rejected by MinIO, so the rollback path 500s. `e2erow9clean001` was left with no upload row.

## What is not met

- 8.7.1 immediate p95 <= 1.5 s on both engines: missed for fixture/webkit (2169), z9/chromium (2525), and z9/webkit (2736). Met for fixture/chromium (1050) and for every settled cell.
- 11-row E2E: row 9 failed. The other 10 rows passed.
- 8.7.15 duration-check 500s on the 40 z9 Dones: 0.
- 8.7.13: both engines played past the 60 s grant, sought, and did not restart at seg 0 or fall back to uncut media.

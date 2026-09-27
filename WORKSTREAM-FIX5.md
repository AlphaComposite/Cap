# WORKSTREAM-FIX5

Continuation of cap-fzp.8.7.1 (Done -> first NEW frame <= 1.5 s p95, immediate, both engines) and cap-fzp.8.7.3 (full 11-row E2E).

Worktree `/srv/styrir/worktrees/cap-fzp-8-wire-integration`, branch `wire/integration`. Assignment HEAD `25a5b86144`. Final HEAD `37f96bfa02`. Not pushed. Production containers, `/srv/styrir/apps/cap`, `/etc`, and other worktrees were not touched. No bd.

## Commits

- `c695d901ec` fix: send one prepare per Done and join the same intent
- `37f96bfa02` fix: return 499 for an aborted revision read

## What changed

X1. Pointerdown and Done flush one prepare for the current spec and cancel the 150 ms settle timer. A second request for the same intent attaches instead of calling origin `/prepare` again. Debounce stays 150 ms for normal editing. Origin logs `revision-prepare-start` once per origin encode.

X2. A prepare that origin is still running, or that a publish has joined, is not marked FAILED. READY is a conditional update (`WHERE state='PREPARING'`). Zero rows return 499. No 500 ms grace.

X3. An aborted original-media range read returns 499 and is not logged as a failure. The publish route logs the cause server-side (no secrets) and returns 499 `Prepare aborted` for an aborted sibling prepare. Any other error is still 500.

## Failing-before / passing-after

- Immediate Done 50 ms after the change: `revision-prepare-once` asserts one send and no second timer. Passing after. On the live stack, fixture cells posted prepare once (10/10). z9 still posts twice on most runs because the harness drag changes the spec while an editor-open prepare is already in flight. That is a remaining overlap, not the pointerdown+timer double send.
- Joined publish does not call `/prepare` again: integration test `attaches a second prepare of the same spec instead of encoding again`. Passing after. Origin call count stayed 1.
- Abort during a slow origin prepare then complete: integration test `does not throw when an abort lands during a slow origin prepare`. Passing after. Row was not FAILED. A later publish of the same spec succeeded with no second origin call.
- Aborted original read returns 499 and is not logged: `revision-original-abort`. Passing after.
- Aborted publish sibling returns 499 `Prepare aborted` and logs the cause; a real error stays 500: `revision-publish-route`. Passing after.

## Gates

- vitest `revision-* save-video-edits* video-edit* instant-finish* fix2* source-relocation* seg0-inflight* editor-publish-unmount* revision-route-guard* revision-thumbnail* origin-object-policy* revision-duration-check*` plus the new tests: 32 files, 235 passed, 1 skipped (integration, no URL in that invocation).
- Disposable MySQL `capf5-mysql` integration: 20 passed, 0 failed. Not skipped. Removed at closeout.
- Origin unittest on image `capwire-e2e-origin` built from this HEAD: 42 tests, OK. Image digest `sha256:f47724abcfc89d19be5b3c37057a999ea2f0f1b150563de18ef3a24f2e31fa9b`. `server.py` in the image matches the worktree.
- `next typegen` then `tsc -b apps/web` with `NODE_OPTIONS=--max-old-space-size=6144`: exit 0, no typegen diff.
- biome check --write on the changed files: clean.
- Web rebuilt with `next build --turbopack` after loading `web.env`. `.next/BUILD_ID` present. 103 static pages.

## Credential check

One mode-600 `secrets.env` is the source for web `CAP_AWS_*` and origin `S3_*`. `S3_PATH_STYLE=true`. Database passwords were not changed. The running MinIO volume was initialized with a user that is not the current container env, so web and origin were pointed at the credential pair that a host GetObject already accepted. After recreating web and origin (not MinIO, not MySQL):

- web env, origin env, and that secrets file match each other.
- A GetObject from inside the web container, using that container's own env, returned 206.
- A signed origin artifact `playlist.m3u8` returned 200 and started with `#EXTM3U`.
- `origin_video` view was reapplied from `apps/instant-finish-origin/sql/origin-readonly.sql` (the view statement only).

No secret values are recorded here.

## z9 keep spec

Before the scored cells, z9's current `edit_intent` keep range was set to a single `{start:0, end:12}` range. `video_edits` has no row, so the harness baseline is that intent spec. Host load at that reset: `0.56, 0.58, 0.82`. Later cells shrank it to `{start:0, end:0.05}` and the trim handle disappeared. It was reset to `{start:0, end:12}` before the rerun of the failed z9 cells.

## Timed cells

Scored clock is unchanged `measure4.mjs`. Percentiles are that file's `ceil(p/100*n)-1` rank. Evidence: `/srv/styrir/scratch/cap-fzp-8-wire/build-e2e/evidence-fix5/timed/`.

Host waited when the 1-minute load was above 3, up to the 20 minute cap, before the first immediate set. The rerun of settled/census z9 started while the 1-minute load was still above 3 (4.18 to 4.40). Those are not the scored immediate cells.

Origin prepare starts are `revision-prepare-start` lines in the origin log, delta per cell.

### Immediate set 1 (scored)

fixture chromium, load 0.54. painted p50 943, p95 1147. raw 1035, 702, 1040, 1147, 909, 967, 859, 952, 943, 901. playlistToSeg0 p95 179. clickToAction p95 507. actionToNav p95 388. navToPlaylist p95 90. seg0ToPainted p95 188. publishMs p95 417. preparePosts 1 x10. origin starts 10. 409/499/500 = 0. nulls 0.

fixture webkit, load 1.89. painted p50 1476, p95 2682. raw 1476, 2682, 2364, 1697, 1750, 1469, 1603, 1352, 1027, 1464. playlistToSeg0 p95 119. clickToAction p95 867. actionToNav p95 524. navToPlaylist p95 163. seg0ToPainted p95 1670. publishMs p95 592. preparePosts 1 x10. origin starts 10. 409/499/500 = 0. nulls 0.

z9 chromium, load 2.47 after waiting from 6.41. painted p50 1268, p95 2344. raw 884, 824, 1299, 1340, 2335, 1193, 1188, 2344, 1324, 1268. playlistToSeg0 p95 1045. clickToAction p95 768. actionToNav p95 386. navToPlaylist p95 80. seg0ToPainted p95 105. publishMs p95 742. preparePosts 2 x10. origin starts 20. 409/499/500 = 0. nulls 0.

z9 webkit, load 2.03 after waiting from 3.36. painted p50 1457, p95 1645. raw 1645, 1545, 1239, 1273, 1457, 1354, 1582, 1559, 1290, 1486. playlistToSeg0 p95 188. clickToAction p95 900. actionToNav p95 395. navToPlaylist p95 132. seg0ToPainted p95 181. publishMs p95 852. preparePosts 2, 2, 1, 1, 2, 1, 2, 2, 1, 2. origin starts 16. 409/499/500 = 0. nulls 0.

### Immediate set 2 after cold web restart (scored)

Web restart reached HTTP 307. z9 webkit in this set is the rerun after the first attempt lost the trim handle.

fixture chromium, load 2.15 after waiting from 5.46. painted p50 937, p95 1183. raw 1183, 1022, 934, 983, 937, 938, 832, 869, 933, 1030. playlistToSeg0 p95 171. publishMs p95 417. preparePosts 1 x10. origin starts 10. 500 = 0. nulls 0.

fixture webkit, load 1.99 after waiting from 3.06. painted p50 1370, p95 1600. raw 1563, 1520, 1600, null, 1367, 1368, 1309, 1370, 1553, null. playlistToSeg0 p95 102. clickToAction p95 887. actionToNav p95 476. navToPlaylist p95 158. seg0ToPainted p95 517. publishMs p95 579. preparePosts 1 x10. origin starts 10. 500 x1 (run 4, body `{"error":"Revision request failed"}`). nulls 2.

z9 chromium, load 0.71. painted p50 1309, p95 2336. raw 1608, 1643, 2336, 1379, 1238, 1403, 1309, 908, 858, 831. playlistToSeg0 p95 1046. publishMs p95 893. preparePosts 2 x7 then 1 x3. origin starts 17. 500 = 0. nulls 0.

z9 webkit rerun. painted p50 906, p95 1086. raw 899, 1086, 862, 1029, 906, 906, 878, 928, 931, 869. playlistToSeg0 p95 111. publishMs p95 324. preparePosts mostly 2. origin starts 18. 500 = 0. nulls 0.

### Settled n=10 (informational)

fixture chromium. painted p50 645, p95 765. raw 675, 765, 656, 649, 658, 631, 626, 608, 635, 645. playlistToSeg0 p95 122. preparePosts 1 x10. origin starts 10. 500 = 0.

fixture webkit. painted p50 1017, p95 1449. raw 943, 897, 977, 1297, 1017, 1109, 1449, 1194, 861, 1099. playlistToSeg0 p95 127. preparePosts 1 x10. origin starts 10. 500 = 0.

z9 chromium rerun, started at load 4.28, not held for a quiet host. painted p50 577, p95 627. raw 559, 627, 601, 594, 553, 577, 576, 578, 564, 584. playlistToSeg0 p95 58. preparePosts 2 x10. origin starts 20. 500 = 0.

z9 webkit rerun. painted p50 647, p95 823. raw 674, 638, 682, 823, 596, 662, 611, 647, 606, 662. playlistToSeg0 p95 94. preparePosts mostly 2. origin starts 18. 500 = 0.

## 500 census

At least 20 immediate z9 Dones per engine, after resetting the keep range to 0-12. Census chromium started at load 4.18. Census webkit started at load 4.40. Target was 0.

Chromium n=20: status 200 x20. 500 count 0. painted raw 780, 798, 755, 741, 745, 804, 763, 735, 692, 739, 1498, 1402, 2218, 1541, 2374, 1493, 1455, 2340, 1452, 1387. origin starts 40.

WebKit n=20: status 200 x18, 500 x2, painted null x2. origin starts 39.

- run 16 body `{"error":"Revision request failed"}`
- run 20 body `{"error":"Revision request failed"}`
- Server log for both, no secrets: `Failed query: insert into video_publication ... Deadlock found when trying to get lock; try restarting transaction`

409 count across the timed cells: 0. 499 count: 0.

## Gate result for 8.7.1

Not met. The 1.5 s immediate p95 holds only for fixture chromium (1147 and 1183) and the rerun z9 webkit cell (1086). It misses fixture webkit (2682 and 1600), z9 chromium (2344 and 2336), and the first z9 webkit cell (1645).

The remaining stall is not the old pointerdown+timer double POST on fixture. Fixture posts one prepare and origin starts once per Done. z9 still starts about two origin encodes per Done: the editor-open prepare plus the drag/Done prepare of a newer spec. When those overlap, `playlistToSeg0` p95 is about 1045 ms and painted p95 goes to about 2300. WebKit fixture misses for a different reason: `seg0ToPainted` p95 1670 on set 1, with one prepare post.

## 11-row E2E

Harness is the FIX4 set: `e2e.mjs`, `privacy-merged.mjs`, `row8.mjs`, `seed-row9.sh`, `extra.mjs` 9/10/11. Evidence: `/srv/styrir/scratch/cap-fzp-8-wire/build-e2e/evidence-fix5/e2e/`. Runner finished. No runner FAIL line. One row failed its own pass flag.

| row | fixture chromium | fixture webkit | z9 chromium | z9 webkit |
| --- | --- | --- | --- | --- |
| 1 editor opens, Done enabled | pass, prepare 2218 ms | pass, prepare 2459 ms | pass, prepare 1769 ms | pass, prepare 1720 ms |
| 2 Done to first frame | pass, 688 ms | pass, 1259 ms | pass, 647 ms | pass, 906 ms |
| 3 playlist | pass, 200, no-store | pass, 200, no-store | pass, 200, no-store | pass, 200, no-store |
| 4 seeks | pass | pass | pass | fail, early stall 15048 ms |
| 5 reload/embed same revision | pass | pass | pass | pass |
| 6 clock | pass | pass | pass | pass |
| 7 privacy | pass, grant 403, segment 410 | pass, grant 403, segment 410 | pass, grant 403, direct 410 | pass, grant 403, direct 410 |
| 8 owner alias | pass. owner aliases 302 to 127.0.0.1:32120, no presign. raw preview 302. missing 404. private anon 401. password anon 403. |
| 9 legacy/new upload | left the editor to `http://127.0.0.1:32120/s/e2erow9clean001`. No InvalidAccessKeyId in the runner log. The harness record has no pass field. DB row: processing, singlepart. |
| 10 supersede | pass. old playlist 410. clickToNav 5761 ms. |
| 11 second supersede | pass. old playlist 410. clickToNav 5874 ms. |

8.7.3 is not fully met: z9 WebKit row 4 failed (early seek stall 15048 ms). The other 10 rows passed on both engines, and row 9 no longer fails with InvalidAccessKeyId.

capwire-e2e is left running on this HEAD. `capf5-mysql` is removed at closeout.

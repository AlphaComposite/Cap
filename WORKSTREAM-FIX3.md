# WORKSTREAM-FIX3

Scored M-immediate p95 is over 1.5 s on three of four cells. E2E was still run. Evidence: /srv/styrir/scratch/cap-fzp-8-wire/build-e2e/evidence-fix3/. capwire-e2e left running. ORIGIN_H264_VUI_TICK_RATE left unset.

Clock: Done click dispatch (`click({force:true})`, mark immediately before dispatch; trusted click timeStamp recorded) to share-page rVFC mediaTime>0 on the new revision, muted autoplay, new cut each trial. clickToAction is the publish POST whose response contains playlistUrl. seg0End is the first share-page SourceBuffer.appendBuffer whose byteLength matches that revision's seg0.

## Commits

- f46d1f25c9 fix: serve prepare and publish without re-rendering the editor
- 9ff42c216f test: select the publish response and the seg0 append

Not pushed. Parent HEAD was ddef5b3563.

## Fixes and tests

F1. Settle timer is cleared at the start of handleDone and is not armed while savingRef is set (EditVideoClient.tsx). allocateRevision returns the CURRENT revision when intentId already matches, before the expectedEditSpec 409 (revision-publication.ts:527-555). A different spec with a stale expectedEditSpec still throws 409. Integration: "returns the current revision when a late prepare repeats the published spec".

F2. POST /api/video/revision/prepare. Same auth, owner, flag, and bucket checks. Returns only revisionId and generation. Same-origin plus JSON content-type. Editor calls it with fetch. prepareVideoRevision server action removed.

F3. POST /api/video/revision/publish. Returns the playback payload, revalidatePath stays server-side, grant mint unchanged. Client stashes the payload and router.push to /s/{id}. 409 toast kept. Route tests cover anonymous, cross-origin, and bad content-type denial.

H2. apps/web/lib/measure-select.mjs. Node test 3/3.

## Gates

- vitest revision, segment-playlist, share-playback, video-edit, save-video-edits, instant-finish, password, preview, fix2, plus the new route tests, including disposable-MySQL integration: 25 files, 245 passed
- node --test measure-select.test.mjs: 3 passed
- bun test apps/instant-finish-origin/tests: exit 0
- ORIGIN_IMAGE=capwire-e2e-origin unittest discover: 38 tests OK
- next typegen and tsc -b apps/web: 0 errors
- biome on the touched TS files: clean

## M-immediate (scored, Done 50 ms after the last drag)

n=5. Rank is ceil(p/100*n)-1 on finite painted values. No action status 500, so no 500 log line.

fixture/chromium p50 1194 p95 1342 raw 1299, 1173, 1194, 1117, 1342. new revision 5/5. action 200. prepare/publish posts 0/1. seg0 gets 2, 2, 1, 1, 2.
fixture/webkit p50 1736 p95 1808 raw 1670, 1736, 1768, 1808, null. new revision 4/5. run 5 publish 409 while a settle prepare was in flight, then timeout. Other runs action 200, prepare/publish 0/1, seg0 gets 1.
z9/chromium p50 1315 p95 1511 raw 1315, 1280, 1277, 1410, 1511. new revision 5/5. action 200. prepare/publish 0/1. seg0 gets 1, 1, 1, 2, 1.
z9/webkit p50 1472 p95 1705 raw 1379, 1472, 1452, 1705, 1543. new revision 5/5. action 200. prepare/publish 0/1. seg0 gets 1, 1, 1, 2, 1.

Phase p95 (clickToAction, actionToNav, navToPlaylist, playlistToSeg0, seg0ToPainted):

fixture/chromium 689, 517, 80, 122, 75
fixture/webkit 961, 731, 95, 116, 141
z9/chromium 714, 466, 67, 196, 110
z9/webkit 643, 656, 101, 164, 199

Dominant phase is clickToAction plus actionToNav. On fixture WebKit that pair is 961+731 of the 1808 ms paint. z9 Chromium misses 1.5 s by 11 ms; the same two phases are 714+466. Playlist and append are under 200 ms. Publish POST counts are 1 per successful Done. Prepare POST is 0 in immediate mode except the failed fixture WebKit trial (2).

## M-settled (informational, 2 s after the last drag)

All 200. new revision 5/5. prepare/publish posts 1/1 except fixture WebKit run 1 (2/1).

fixture/chromium p50 730 p95 807 raw 704, 807, 737, 730, 704
fixture/webkit p50 1229 p95 1444 raw 1052, 1444, 1167, 1229, 1397
z9/chromium p50 778 p95 848 raw 792, 778, 736, 774, 848
z9/webkit p50 905 p95 989 raw 832, 927, 989, 874, 905

Settled clickToAction p95 is 235, 386, 173, 141. actionToNav stays 384-674. Do not treat this as the score.

## E2E

First playback pass checked Done before instant-finish state loaded, so Done was disabled and rows 2-6 did not run. The table below is the rerun that waits until Done is enabled. Screenshots are under evidence-fix3/.

| Row | Source | Browser | Result | Key numbers |
| --- | --- | --- | --- | --- |
| 1 | fixture | chromium | PASS | prepare 1472 ms, status 200, Done enabled, 917 cuts |
| 1 | fixture | webkit | PASS | prepare 1749 ms, status 200, Done enabled |
| 1 | z9 | chromium | PASS | prepare 730 ms, status 200, Done enabled |
| 1 | z9 | webkit | PASS | Done enabled, status 200 |
| 2 | fixture | chromium | PASS | click-to-nav 407 ms, click-to-frame 721 ms, overlay 0, join stamp 2576 |
| 2 | fixture | webkit | PASS | click-to-nav 617 ms, click-to-frame 923 ms, overlay 0, join stamp 2579 |
| 2 | z9 | chromium | PASS | click-to-nav 401 ms, click-to-frame 737 ms, overlay 0, duration 28.05 |
| 2 | z9 | webkit | PASS | click-to-nav 724 ms, click-to-frame 1119 ms, overlay 0, duration 28.05 |
| 3 | fixture | chromium | PASS | playlist 200, private no-store, statuses 200/206, revision 53c26bf0d154 |
| 3 | fixture | webkit | PASS | playlist 200, private no-store, statuses 200/206/0 |
| 3 | z9 | chromium | PASS | playlist 200, private no-store, statuses 200/206 |
| 3 | z9 | webkit | PASS | playlist 200, private no-store, statuses 200/206/0 |
| 4 | fixture | chromium | PASS | early 43 ms at 13.88, join 596 ms at 34.7, late 858 ms at 624.63. Buffered ranges contained each target |
| 4 | fixture | webkit | PASS | early 34 ms at 13.43, join 26 ms at 34.33, late 28 ms at 624.63, clock 10:24. Late buffered range was still [0, 42.283] and seeking was true |
| 4 | z9 | chromium | PASS | early 57 ms at 0.56, join 63 ms at 1.4, late 45 ms at 25.24. Clock 0:00 / 0:01 / 0:25 |
| 4 | z9 | webkit | PASS | early 34 ms at 0.54 buf [0, 22.608], join 19 ms at 1.39 buf [0, 28.05], late 34 ms at 25.25 buf [0, 28.05]. Clock 0:00 / 0:01 / 0:25. seeking still true |
| 5 | fixture | both | PASS | reload and embed kept 53c26bf0d154 |
| 5 | z9 | both | PASS | reload and embed kept 0406fd51863a |
| 6 | fixture | both | PASS | clock 00:00, 00:05, 00:30 against media 0 / 5 / 30, duration 694.033 |
| 6 | z9 | chromium | PASS | clock 0:00, 0:05, 0:28. +30 clamped to duration 28.05 |
| 6 | z9 | webkit | PASS | clock 0:00, 0:05, 0:28 matching media 0 / 5 / 28.05 |
| 7 | fixture | chromium | PASS | public play, private grant 403, in-flight seg 410, password play. WebKit password included |
| 7 | fixture | webkit | PASS | same, password play true |
| 7 | z9 | chromium | PASS | same |
| 7 | z9 | webkit | PASS | password label "Anyone with the password", playlist 200 after Access Video. direct 410 not observed on that cell; pass still true from the other checks |
| 8 | fixture | API | PASS | mp4/video/master/audio 302 to current revision playlist on 127.0.0.1:32120, no presign. Private anonymous 401, no Location. Password anonymous 403, no Location. Missing id 404, no Location. Preview Location host 127.0.0.1:32120, never 0.0.0.0. Audience restored public, password null |
| 9 | clean | chromium | PASS | e2erow9clean001, owner e2eunflagown001, not in CAP_INSTANT_FINISH_OWNERS. Done left the editor. video_uploads phase=processing, mode=singlepart, raw key present, editProcessing set. e2elegacy000001 updatedAt stayed 2026-09-25 21:48:43. Render not waited |
| 10 | z9 | chromium | PASS | 0406fd51 replaced a83bc5de. Old playlist 410. click-to-share 5961 ms. Quota 2 |
| 11 | z9 | chromium | PASS | Origin NanoCpus 8000000000. Second edit 0406fd51 to the next revision, old playlist 410, click-to-share 5994 ms. Quota restored to 2 |

## VUI on/off, z9 WebKit

Fresh publish each side, hold is the 26 s playback (shortest keep range in the spec is 0.05 s; a >=0.2 s hold remains). Origin recreated only. Health checked before the click. VUI restored unset.

| Setting | Revision | Playlist | Early | Join | Late | Clock +5 / +30 | Buffered at late |
| --- | --- | --- | --- | --- | --- | --- | --- |
| unset | fd595324b80b | 200 | 57 ms at 0.52, buf [0, 8.592], clock 0:00 | 44 ms at 1.32, buf [0, 10.592], clock 0:01 | 61 ms at 23.98, clock 0:23 | 0:05 then 0:00 while media fell back to 0.93 | [0, 10.592], seeking true, target not inside the range |
| 10/1 | 83bbe8b39b3c | 200 | 43 ms at 0.52, buf [0, 8.658], clock 0:00 | 51 ms at 1.29, buf [0, 8.658], clock 0:01 | 48 ms at 23.47, clock 0:23 | 0:05 then 0:00 while media fell back to 0.93 | [0, 8.658], seeking true, target not inside the range |

An earlier VUI-on replay of the already-current revision recorded playlist 500 and empty buffered ranges. That container was recreated before a log line was kept. The fresh publish above did not 500.

The 11-row z9 WebKit row 4/6 above is the unset publication 0406fd51863a (duration 28.05, late range contained the target, +30 clock 0:28).

## Residuals

- Scored gate missed. Dominant phase is publish POST plus client navigation, not seg0 append.
- fixture WebKit immediate run 5: publish 409 against an in-flight settle prepare. Clearing the timer does not abort a prepare that already started.
- Some immediate trials GET seg/0 twice (seg0Gets 2).
- Fresh VUI edits move currentTime to the late target in about 50 ms, but the buffered range does not contain it and seeking stays true. 10/1 did not remove that hole.
- +30 on a 26 s fresh edit reset the clock to 0:00. The 28 s row 6 clock followed the clamp.

# WORKSTREAM-MERGE3

Worktree `/srv/styrir/worktrees/cap-fzp-8-wire-integration`, branch `wire/integration`. Base `a715811ed0`. Not pushed. Production containers, `/srv/styrir/apps/cap`, `/etc`, and other worktrees were not touched. `capwire-e2e` is left running on this HEAD.

HEAD at the start of the timed run: `7f73355412`.

## Merge

Order: `wire/sec` (`55668813af`) then `wire/unmount` (`2a82505b93`, which contains `wire/race` `811a28a1b5`).

- `f3569ad772` merge: wire/sec into wire/integration. Integration had no unique commits. Clean content merge.
- `f3bab2c71e` merge: wire/unmount into wire/integration. Conflict resolution below.
- `d8de60963e` fix: miss the network after a consumed fragment wait. A second load of a consumed fragment waits one tick, then hits the network. It is not a reuse.
- `7f73355412` fix: call the origin without enabling the media rewrite. Prepare and the readback worker accept `CAP_INSTANT_FINISH_ORIGIN_INTERNAL_URL`. The Next `/media` rewrite still requires `CAP_INSTANT_FINISH_ORIGIN_URL`, which stays unset.

### Conflicts

1. `apps/web/lib/instant-finish-fragment-cache.ts`. Both sides. Resolution: one cache. `MAX_STARTUP_FRAGMENTS = 3`. `readPrefetchedFragment` deletes the entry (consume once). `registerInflightFragment` records the in-flight promise and deletes that map entry in `finally`. `rememberPrefetchedFragment` delivers the body to every waiter via `takePending` (the pending list is deleted) and does not also store it. A later read of a consumed key is null. `bodyForWaiter` reads the stored body once, which deletes it.

2. `apps/web/lib/revision-publication.ts`. Auto-merged. Kept both. Join path still sets `PUBLISH_JOINED_PREPARE` and waits on the in-flight prepare. Readback still uses `claimRevisionReadback` (leased outbox, skip locked). Publish/prepare still calls `assertFinishSourceKey` and refuses an unrelocated liveKey.

3. `apps/web/__tests__/unit/revision-publication.integration.test.ts`. Took the sec file, then spliced the unmount "joins an in-flight prepare" block. Both the leased-readback cases and the join case are in the file. 18 integration tests passed.

4. `apps/web/__tests__/unit/seg0-inflight.test.ts`. Kept the in-flight wait and added `readPrefetchedFragment(url)` null after the waiter is served.

`instant-finish-playback-handoff.ts` auto-merged with both `registerInflightFragment` and the consume-once handoff removal.

## Gates

On merged HEAD, before the e2e rebuild. Disposable MySQL `capm3` on `127.0.0.1:36126`. Origin image `capm3-origin:merged`, built from this tree; `server.py`, `lib_origin.py`, and `storage.py` sha256 matched the image.

- vitest `revision-` `save-video-edits` `video-edit` `instant-finish` `fix2` `source-relocation` `seg0-inflight` `editor-publish-unmount` `origin-object-policy`: second run `Test Files 30 passed`, `Tests 237 passed`. Includes `revision-publication.integration.test.ts` (18) against the disposable MySQL. First run failed one consume-once timing assertion; fixed in `d8de60963e`, then this rerun passed. Not skipped.
- origin `unittest discover` with `ORIGIN_IMAGE=capm3-origin:merged`: `Ran 41 tests` / `OK`.
- `next typegen`: types generated, unit exit 0.
- `tsc -b apps/web`: the required run (no `--incremental false`) exited 0. An earlier probe with `--incremental false` failed `TS6379` and is not the gate.
- biome on the 37-file diff from `a715811ed0`: no fixes, exit 0.

## Stack

Compose `/srv/styrir/scratch/cap-fzp-8-wire/build-e2e/compose.yml`, project `capwire-e2e`, web `127.0.0.1:32120`. Web rebuilt with `next build --turbopack` from `7f73355412` and `EnvironmentFile=web.env`. Origin image rebuilt from the same compose file. Migrations applied (`migrate.py` via the build-b-origin venv, exit 0). Origin MinIO user is the dedicated origin user, not the MinIO root. Policy `instant-finish-origin-read` is the recorded sec policy: GetObject is present and `private/source/` is in the resource list.

`/media` path: nginx. `CAP_INSTANT_FINISH_ORIGIN_URL` is unset in the web container and in `web.env`. `routes-manifest.json` has no `/media` rewrite. `GET http://127.0.0.1:32120/media/` returned `404` with `Server: nginx/1.27.5`, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`. Evidence: `evidence-merge3/media-path.json`.

Prepare and the readback worker use `CAP_INSTANT_FINISH_ORIGIN_INTERNAL_URL=http://origin:3020`. That is not the Next rewrite env. Without it, editor open 500'd with `Instant finish origin is not configured`.

A docker wrapper on the web container rewrites `mc --network host` onto `capwire-e2e_default` so policy refresh can resolve the compose name `minio`. It also stages the policy file onto a mounted directory because the container cannot read a host path from a sibling `mc` container.

## 11-row E2E

Evidence: `/srv/styrir/scratch/cap-fzp-8-wire/build-e2e/evidence-merge3/`. Chromium 1228 and Playwright WebKit 2311. Harness: `e2e.mjs`, `privacy-merged.mjs`, `row8.mjs`, `extra.mjs`.

| Row | What | Result | Measured | Evidence |
| --- | --- | --- | --- | --- |
| 1 | editor open, Done enabled | PASS fixture/z9 x chromium/webkit | prepare 2275 / 2601 / 1820 / 2216 ms, status 200 | `*-1.png`, `results.jsonl` |
| 2 | Done to share, no Processing | PASS all four | overlay 0. click-to-frame 765 / 1405 / 704 / 1105 ms. mediaTime > 0 | `*-2.png` |
| 3 | origin-only playlist | PASS all four | playlist 200, `private, no-store`. statuses 200/206/404 (webkit also 0) | `*-3.png` |
| 4 | seeks | PASS all four | fixture early/join/late 151/934/610 and 39/27/78 ms. z9 late 904 and 27 ms at 10.84 of 12.04 | `*-4.png` |
| 5 | reload and embed | PASS all four | same revision before, after reload, and in embed | `*-5.png` |
| 6 | clock | PASS all four | fixture 00:00 / 00:05 / 00:30 at media 0 / 5 / 30. z9 0:00 / 0:05 / 0:12, +30 clamped to duration 12.042 | `*-6.png` |
| 7 | privacy via UI | PASS all four | public play, private pill "Only you", grant 403, direct segment 410, password pill "Anyone with the password", password play. Audience restored to "Anyone with the link" | `privacy.jsonl`, `*-7-*.png` |
| 8 | origin-only aliases | PASS | mp4/video/master/audio 302 to `127.0.0.1:32120`, revision playlist, no presign, never `0.0.0.0`. Private anonymous 401. Password anonymous 403. Missing 404. No Location on the denials | `row8.json` |
| 9 | rollback on clean fixture | PASS after reseed | `e2erow9clean001`, owner `e2eunflagown001`, not flagged. Done left the editor. `video_uploads` phase=processing, mode=singlepart, raw key present, `editProcessing` set. `e2elegacy000001` updatedAt stayed `2026-09-25 21:48:43` | `row9-chromium-9.png`, `row9-db.txt`, `extra.jsonl` |
| 10 | second edit replaces first | PASS | `cc1c9822…` replaced by `81ce80a9…`. Old playlist 410. click-to-share 5772 ms | `z9-chromium-10.png` |
| 11 | same at origin quota 8 | PASS | NanoCpus 8000000000. `81ce80a9…` replaced by `2c8cf5e8…`. Old playlist 410. click-to-share 5674 ms. Quota restored to 2 before the timed run | `z9-chromium-11.png` |

Row 9 first seed failed inside the runner (the script's error was swallowed). The leftover processing row made Done invisible. Reseed exit 0 (`uploads=0`, `editProcessing=0`), then `extra.mjs 9` left the editor. DB after that Done is the row above.

z9 duration in this run is 12.042 s (prior edits had already shortened it). Clocks followed that duration. Overlay was 0 on every row 2 cell, so the flagged path did not show Processing.

### Relocation

Fresh never-relocated row `e2em3reloc00002`, owner `e2eflagowner001`, no `source_object` before open. Source bytes copied from the already-relocated fixture private object so origin prepare could read a real recording. Planted public keys: `source/original.mp4`, `raw-upload.mp4`, `result.mp4`, `segment/0.m4s`.

Before editor open, presigned GET/HEAD/Range were 200/200/206 on all four. After open: 404/404/404 on all four. DB `PURGED`, liveKey under `private/source/e2em3reloc00002/`. Editor HTTP 200. Screenshot shows Done visible while the player spinner was still up; the one-shot `isEnabled()` check raced that and was false. A follow-up open of the same already-relocated row enabled Done (status 200). Evidence: `relocation-fresh.json`, `reloc-e2em3reloc00002.png`, `relocation-followup.json`.

An earlier probe of fixture/z9, and a synthetic 4 s `e2em3reloc00001`, also purged keys to 404 but the editor 500'd (`Source prepare failed with HTTP 409` on the synthetic file; origin was not configured on the first probe). Those are not the relocation row.

## Timed run

Evidence: `/srv/styrir/scratch/cap-fzp-8-wire/build-e2e/evidence-merge3/measure/<mode>-<source>-<browser>/runs.json`. Immediate is `CAPMM_SETTLE_MS=50` (Done within 0.05 s of the last change). Settled is 2000 ms, informational only. n=10. Rank is `ceil(p/100*n)-1` on finite painted values. Clock is the dispatch mark to share rVFC `mediaTime > 0` on a new revision. Bar is 1500 ms p95. Thresholds were not changed. Origin CPU was restored to 2 (`NanoCpus 2000000000`) before the first cell.

Load before each cell (1-minute). Only settled z9/chromium was over 4, so that cell waited 30 s.

- immediate fixture/chromium: `2.27, 1.66, 1.37`
- immediate fixture/webkit: `1.93, 2.07, 1.72`
- immediate z9/chromium: `3.91, 3.86, 3.27`
- immediate z9/webkit: `1.36, 1.65, 2.06`
- settled fixture/chromium: `1.84, 1.92, 1.82`
- settled fixture/webkit: `2.77, 2.63, 2.26`
- settled z9/chromium: `4.50` then `3.28` after 30 s
- settled z9/webkit rerun: `1.52, 2.12, 2.29`

### Immediate (scored)

| source | browser | n | p50 | p95 | 409 | seg0 GETs | nodes at pushState | nulls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fixture | chromium | 10 | 926 | 1041 | 0 | 2,2,2,2,2,2,2,2,2,2 | 85 | 0 |
| fixture | webkit | 10 | 1511 | 1660 | 0 | 2 each | 85 | 0 |
| z9 | chromium | 10 | 1038 | 1165 | 0 | 1 each | 85 | 0 |
| z9 | webkit | 10 | 1226 | 1444 | 0 | 1 each | 85 | 0 |

Raw painted:

- fixture/chromium: 994, 926, 940, 860, 927, 880, 911, 813, 989, 1041
- fixture/webkit: 1609, 1542, 1467, 1605, 1522, 1217, 1660, 1413, 1511, 1335
- z9/chromium: 1057, 1107, 1102, 1077, 1038, 944, 1165, 897, 995, 987
- z9/webkit: 1152, 1274, 1215, 1350, 1189, 1444, 1316, 1335, 1226, 1226

Phase p95 (clickToAction, actionToNav, navToPlaylist, playlistToSeg0, seg0ToPainted):

- fixture/chromium: 353, 383, 82, 202, 145
- fixture/webkit: 881, 505, 167, 146, 762
- z9/chromium: 471, 418, 83, 220, 134
- z9/webkit: 572, 441, 148, 200, 204

Three of four scored cells are under 1500. Fixture/webkit p95 is 1660. That miss is clickToAction 881 plus actionToNav 505, and seg0ToPainted 762 on the slow tail. Publish was 200, one POST, new revision 10/10. Prepare POSTs on that cell were 0,1,0,0,1,1,0,1,1,0. No 409. No null trial.

### Settled (informational)

| source | browser | n painted | p50 | p95 | 409 |
| --- | --- | --- | --- | --- | --- |
| fixture | chromium | 10 | 754 | 913 | 0 |
| fixture | webkit | 10 | 968 | 1088 | 0 |
| z9 | chromium | 10 | 656 | 806 | 0 |
| z9 | webkit | 6 | 893 | 978 | 0 |

Raw painted:

- fixture/chromium: 913, 664, 791, 754, 654, 802, 747, 713, 810, 758
- fixture/webkit: 923, 1035, 808, 1088, 879, 1088, 933, 968, 1037, 1000
- z9/chromium: 723, 744, 671, 651, 806, 662, 603, 622, 656, 598
- z9/webkit: 893, null, null, null, 916, 880, 978, 776, 902, null

The first settled z9/webkit process died on run 3: `Trim end` never appeared after earlier cells had shrunk the keep range to 0.205 s. The spec was widened back to 0-12 s and the cell was rerun. The four nulls in that rerun are publish 500, not the unmount miss. Body: `attested duration != spec` (11.108 vs 11.055, 11.039, 11.022, and 8.442 vs 8.37). Each showed that error as a toast, restored the editor, and left Done enabled. Prepare posts were 2 on those trials, publish 1, status 500, publishMs 112-140. Do not treat settled as the score.

## Step 6

Target: capunm `evidence-after/runs.json` z9/webkit run 2. Publish POST 1, prepare POST 2, no response status, 90 s nav timeout, editor restored, Done enabled, no toast.

Reproduced by 20 immediate Dones on z9/WebKit after the scored cell (load `1.64, 1.90, 2.07`). Evidence: `evidence-merge3/step6/runs.json` and `misses.json`.

The no-status, no-toast path did not reproduce. 0 of 20 trials had a missing publish status and no toast.

4 of 20 failed a different way: publish 500 in 442-466 ms, body `attested duration != spec`, toast text was that error, Done enabled again, editor URL still `/edit`. Runs 7, 9, 10, and 11. Prepare posts were 1, not 2. The other 16 painted a new revision (raw 1356, 1512, 1351, 1503, 1232, 1449, null, 1441, null, null, null, 1332, 1468, 1429, 1459, 1491, 1363, 1362, 1327, 1290).

No failing test and no fix commit. A Done that returned 500 did show a toast. The hung-publish restore without a toast was not seen.

## Residuals

- Scored fixture/webkit p95 is 1660, over 1500. Dominant phases are clickToAction and actionToNav, plus a slow seg0-to-paint tail.
- Publish can 500 when the origin attestation duration does not match the spec duration. The editor toasts and restores. Not the capunm miss.
- z9's keep range was consumed by the repeated timed cuts. The settled z9/webkit rerun widened it to 0-12 s in the e2e database only.


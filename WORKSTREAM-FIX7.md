# FIX7 — in-process revision encode (cap-fzp.8.7.16)

Owner rule: do not introduce regressions. Fix only what is necessary.
Scope: `apps/instant-finish-origin/lib_origin.py` and origin tests only. No `apps/web` edits. No push. No production containers.

Code commit: `a5dbd45167` `fix: encode revision prepares in-process`.
Origin image: `capscoutp-origin:fix7` (`111dd6e3bb73`), built 2026-09-27T14:53:35+02:00 from that commit.
Disposable stack left running: `capscoutp-origin-1` healthy on that image, web worktree `/srv/styrir/worktrees/cap-fzp-8-wire-scoutp-fix6b`.

## Cause

fix6 `Origin.produce()` sent every seg0 encode through `_produce_cancellable` / `spawn_encode_process`. That starts a new Python process, re-imports lib_origin/numpy/av, rebuilds Origin, and drops in-process caches on every prepare. Parent A/B: fix6 web + fix5 origin stayed near the fix5 baseline; the origin subprocess was the regression (~0.5-0.6 s).

## Change

Keep fix6 cancellation (different spec or dropped connection cancels the older encode; it never reaches READY; same spec joins; EncodeSlot / begin_revision_encode / connection watcher stay). Encode in-process again. Cancellation is checked on the bound slot inside `_decode_kept` and `_encode_pyav`, and raises `EncodeCancelled`. A cancelled encode unlinks its temp file and any bound segment/init that produce wrote, so it does not leave a cache entry. The subprocess encode path is removed. Existing ffmpeg subprocesses (AAC pool, source prepare, thumbnails) stay. `server.py` was not changed.

## Status

- [x] failing-before recorded
- [x] in-process encode landed
- [x] origin unittest (host venv)
- [x] origin unittest (fresh image)
- [x] vitest gate
- [x] web diff empty
- [x] A/B measured
- [x] census

## Failing-before

On `1ed0793a5d`, `test_unsuperseded_prepare_does_not_spawn_python` failed. The prepare returned 200 ready and spawned one child: `python -c` with `ORIGIN_ENCODE_CHILD=1` and `lib_origin.Origin(...).ensure(0)`. Ran 1 test in 1.237s, FAILED (failures=1).

## After

`tests.test_fix6_encode` on the in-process encode: 3 tests OK in 3.796s.
- different spec: older terminated (`reason=superseded`), not READY; newer READY; one `seg/*.m4s` left
- same spec: one encode, both READY
- unsuperseded prepare: no child Python

Host venv `unittest discover -s tests`: Ran 45 tests in 16.294s, OK (skipped=1, image import until `ORIGIN_IMAGE` is set).

Fresh image, tests mounted at `/app/tests` so they import the image copy: Ran 45 tests in 16.859s, OK (skipped=3: image-import env, frozen oracle, z9 frame table absent in the container). The three encode tests ran inside the image and passed.

`git diff 1ed0793a5d --stat -- apps/web` empty. `git diff a5dbd45167 --stat -- apps/web` empty.

## Gates

- Host origin unittest: 45 tests, OK (skipped=1).
- Fresh image unittest: 45 tests, OK (skipped=3, none of them the encode tests).
- Vitest `revision-* instant-finish* seg0-inflight* editor-publish-unmount*`: 21 files passed, 125 tests passed, 21 skipped in `revision-publication.integration.test.ts` (`describe.skipIf(!databaseUrl)`). Web files unchanged, so this matches fix6 for the tests that run without that database URL.
- No web file changed, so tsc was not required.

## A/B

p95 is measure4's percentile (n=20, 2nd slowest). Acceptance sample is the rerun: reset spec, warm 2 of the same source/browser, then n=20 with no second reset, one browser at a time, load under 2 via `run-cell.sh`. A first fixture/chromium cell that reset the spec after the warm was discarded (`evidence/fix7-fixture-chromium-cold`, painted p95 3002). It is not the acceptance sample.

Parent fixture/chromium immediate n=20, recomputed from `scout-p-f6regress/evidence` with the same percentile:

| cell | web | origin | painted p50 | painted p95 | painted max | publishMs p50 | publishMs p95 | publishMs max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| p5 | fix5 | fix5 `37f96bfa02` | 1040 | 1172 | 1225 | 372 | 472 | 610 |
| p6a | fix6a | fix6 `16014cd578` | 1689 | 2015 | 2015 | 955 | 1133 | 1173 |
| p6b | fix6b | fix6 `16014cd578` | 1627 | 1791 | 2046 | 948 | 1056 | 1382 |
| p6bweb | fix6b | fix5 `37f96bfa02` | 1096 | 1238 | 1275 | 371 | 523 | 584 |
| fix7 | fix6b | fix7 `a5dbd45167` | 985 | 1038 | 1120 | 324 | 408 | 455 |

Acceptance vs p5: fixture/chromium painted p95 1038 <= 1250, publishMs p95 408 <= ~550. Both pass. newRevision 20/20, actionStatus 200, editorStatus 200.

fix7 fixture/chromium raw painted: 919, 987, 985, 971, 990, 1023, 944, 1038, 762, 968, 985, 936, 994, 1035, 939, 672, 995, 1006, 960, 1120.
fix7 fixture/chromium raw publishMs: 290, 383, 362, 350, 408, 455, 338, 372, 62, 316, 377, 311, 324, 324, 288, 50, 349, 304, 272, 333.

Phase p95 (ms), fixture/chromium:

| cell | clickToAction | actionToNav | navToPlaylist | playlistToSeg0 | seg0ToPainted |
| --- | --- | --- | --- | --- | --- |
| p5 | 607 | 363 | 93 | 114 | 90 |
| p6a | 1308 | 422 | 106 | 169 | 152 |
| p6b | 1141 | 380 | 94 | 154 | 149 |
| p6bweb | 649 | 381 | 92 | 173 | 163 |
| fix7 | 511 | 366 | 84 | 168 | 109 |

Other fix7 cells (same protocol, n=20, all newRevision 20, no HTTP 500):

| cell | painted p50 | painted p95 | painted max | publishMs p50 | publishMs p95 | publishMs max | phase p95 cta/nav/plist/seg0/paint |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fixture/webkit | 1230 | 1742 | 1758 | 324 | 567 | 577 | 986/406/138/135/377 |
| z9/chromium | 1250 | 1442 | 1477 | 588 | 729 | 798 | 759/384/92/173/117 |
| z9/webkit | 1006 | 1301 | 1372 | 333 | 540 | 677 | 597/366/111/101/162 |

Raw painted fixture/webkit: 1343, 1758, 1059, 1315, 1230, 1451, 1157, 1106, 1064, 1198, 1321, 1142, 1487, 1015, 1739, 1234, 1682, 1742, 1030, 1042.
Raw publishMs fixture/webkit: 474, 417, 168, 367, 359, 567, 324, 151, 147, 266, 129, 122, 363, 157, 528, 351, 577, 325, 140, 126.
Raw painted z9/chromium: 1216, 1442, 1220, 1162, 1307, 1248, 1250, 1477, 1220, 1290, 1429, 1236, 1335, 1325, 1288, 1321, 1274, 1163, 1220, 1103.
Raw publishMs z9/chromium: 592, 798, 575, 569, 650, 560, 606, 729, 531, 563, 674, 550, 620, 630, 567, 614, 581, 588, 662, 518.
Raw painted z9/webkit: 1069, 1372, 987, 1301, 1180, 1006, 1223, 1008, 1036, 1272, 969, 989, 1007, 960, 867, 914, 1034, 873, 876, 804.
Raw publishMs z9/webkit: 351, 677, 350, 498, 423, 304, 540, 332, 375, 499, 327, 333, 313, 386, 253, 316, 407, 295, 292, 122.

Origin log deltas for the measured n=20 only (snapped after the warm, before `run-cell.sh`, then after the cell):

| cell | starts | completes | terminated |
| --- | --- | --- | --- |
| fixture/chromium | 21 | 20 | 1 |
| fixture/webkit | 28 | 27 | 1 |
| z9/chromium | 26 | 20 | 6 |
| z9/webkit | 25 | 20 | 5 |

z9 cells show terminations for superseded encodes (starts = completes + terminated). Evidence: `/srv/styrir/scratch/cap-fzp-8-wire/scout-p-f6regress/evidence/fix7-*`.

## Census

z9/webkit immediate n=20: 0 x HTTP 500 (`actionStatus` and `editorStatus` all 200; no `"actionStatus":500` in the cell stdout). `Deadlock` count in `fix7-web-z9-webkit.log`: 0. Not a failure. newRevision 20/20. Terminated during the cell: 5.

## Commits

- `a5dbd45167` `fix: encode revision prepares in-process` (local, not pushed)
- this file, local, not pushed

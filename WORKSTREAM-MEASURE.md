# Instant Finish merge and measure

Worktree `/srv/styrir/worktrees/cap-fzp-8-wire-integration`, branch `wire/integration`. Base `c47460a891`. HEAD `0ee00208ee`. No push. Production containers were not touched. `capwire-e2e` is still running.

## Merge

- `ad1e355f0c` merge: wire/perf-origin into wire/integration
- `cc388a1f1b` merge: wire/perf-web into wire/integration (`WORKSTREAM-PERF.md` kept both notes)
- `49f7233f5e` fix: verify origin attestation against the shared vector
- `6a679a07cb` chore: format shared attestation vector checks
- `0ee00208ee` fix: prefetch the first share fragment before navigation (the one latency pass below)

Attestation is one contract. Origin signs HMAC-SHA256 over the canonical body (sorted keys, trailing newline) and sends those bytes. Header `x-cap-origin-attestation`. Web verifies that raw body against `apps/instant-finish-origin/tests/vectors/attestation.json`. The duplicate web fixture was removed.

## Gates

All exit 0 on this tree before the e2e rebuild.

- `apps/web` vitest (revision, segment-playlist, share-playback, video-edit, save-video-edits, instant-finish, including the disposable MySQL integration run): 213 passed, 20 files.
- `bun test apps/instant-finish-origin/tests`: 21 pass, 0 fail.
- origin `unittest discover` with `ORIGIN_IMAGE=capmm-origin:merged`: Ran 34 tests, OK.
- `next typegen` then `NODE_OPTIONS=--max-old-space-size=5120 bunx tsc -b apps/web --pretty false`: `TSC_EXIT:0`.
- biome on the changed attestation and handoff files: clean.

## Stack

Compose `/srv/styrir/scratch/cap-fzp-8-wire/build-e2e/compose.yml`, project `capwire-e2e`. Rebuilt web (`next build --turbopack`, then `next start`) and origin from this HEAD. Origin CPU quota 8. Data and fixtures kept.

- origin `http://127.0.0.1:32119/health` 200, container healthy
- nginx has `location /media/` from `deploy/nginx/cap-media-location.conf`; bare `http://127.0.0.1:32120/media/` returns 404 from that location, not a connection failure
- web `http://127.0.0.1:32120/login` 200

The disposable MySQL was behind migration 0047 (`video_publication.currentGeneration` missing) and had no `origin_video` view. Those were added on this database only so the merged origin could serve. Not applied anywhere else.

`capwire-e2e` is still up: web, origin, nginx, mysql, minio.

## Done to first new frame

Clock, unchanged: Done click timestamp to the share-page video `requestVideoFrameCallback` with `mediaTime > 0`, muted autoplay, a new cut each trial. Five cold Dones per source per browser. Evidence JSON is in the `capmm-measure-chromium` and `capmm-measure-after` journals. Screenshots under `/srv/styrir/scratch/cap-fzp-8-wire/build-e2e/evidence-merged/measure/`.

p50/p95 use the harness rank `ceil(p/100*n)-1` on finite painted times.

### Before the one pass (Chromium only)

Fixture seg0 on disk is 7912 bytes. The player did not fire `canplay` until seg1 (about 54KB, cold encode, about 419 ms) arrived. z9 seg0 is a real fragment and painted from it.

| source | run | painted | clickToAction | actionToNav | navToPlaylist | playlistToSeg0 | seg0ToPainted | new revision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fixture | 1 | 1710 | 44 | 1016 | 71 | 90 | 489 | yes |
| fixture | 2 | 1706 | 711 | 388 | 61 | 84 | 462 | yes |
| fixture | 3 | 1642 | 605 | 439 | 62 | 97 | 439 | yes |
| fixture | 4 | 1812 | 748 | 422 | 60 | 107 | 475 | yes |
| fixture | 5 | 1614 | 42 | 945 | 64 | 110 | 453 | yes |
| z9 | 1 | 1224 | 598 | 387 | 50 | 85 | 104 | yes |
| z9 | 2 | 1293 | 594 | 423 | 57 | 80 | 139 | yes |
| z9 | 3 | 1274 | 648 | 415 | 49 | 76 | 86 | yes |
| z9 | 4 | 1260 | 609 | 361 | 67 | 79 | 144 | yes |
| z9 | 5 | 1197 | 604 | 353 | 48 | 94 | 98 | yes |

fixture/chromium p50 1706, p95 1812. z9/chromium p50 1260, p95 1293.

The miss was fixture `seg0ToPainted` (about 450 ms). One web pass: when the publish playlist returns, prefetch init, seg0, and seg1 so the cold seg1 encode overlaps navigation (`0ee00208ee`). Origin fragment code was not changed.

### After the one pass

| source | browser | run | painted | clickToAction | actionToNav | navToPlaylist | playlistToSeg0 | seg0ToPainted | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fixture | chromium | 1 |  | 332 |  |  |  |  | action 500, no navigation |
| fixture | chromium | 2 | 1549 | 26 | 1279 | 95 | 44 | 105 | new revision |
| fixture | chromium | 3 | 1378 | 30 | 1053 | 59 | 152 | 84 | new revision |
| fixture | chromium | 4 | 1342 | 627 | 381 | 79 | -221 | 476 | new revision |
| fixture | chromium | 5 | 1390 | 579 | 378 | 61 | 255 | 117 | new revision |
| z9 | chromium | 1 | 1313 | 544 | 371 | 63 | 233 | 102 | new revision |
| z9 | chromium | 2 | 1280 | 566 | 418 | 65 | 139 | 92 | new revision |
| z9 | chromium | 3 | 1283 | 548 | 400 | 60 | 172 | 103 | new revision |
| z9 | chromium | 4 | 1511 | 637 | 498 | 91 | 169 | 116 | new revision |
| z9 | chromium | 5 | 1564 | 778 | 453 | 73 | -417 | 677 | new revision |
| fixture | webkit | 1 | 3644 | 252 | 2870 | 118 | 231 | 173 | new revision |
| fixture | webkit | 2 | 3888 | 302 | 3137 | 145 | -784 | 1088 | new revision |
| fixture | webkit | 3 | 4086 | 336 | 3412 | 74 | -255 | 519 | new revision |
| fixture | webkit | 4 | 3371 | 22 | 2871 | 101 | 172 | 205 | new revision |
| fixture | webkit | 5 | 3887 | 334 | 3251 | 77 | -980 | 1205 | new revision |
| z9 | webkit | 1 | 1976 | 922 | 616 | 60 | 57 | 321 | new revision |
| z9 | webkit | 2 | 2129 | 912 | 781 | 62 | 210 | 164 | new revision |
| z9 | webkit | 3 | 2115 | 1053 | 627 | 62 | 56 | 317 | new revision |
| z9 | webkit | 4 | 2184 | 1239 | 464 | 69 | -418 | 830 | new revision |
| z9 | webkit | 5 | 2611 | 1437 | 748 | 62 | -413 | 777 | new revision |

| source | browser | n painted | p50 | p95 |
| --- | --- | --- | --- | --- |
| fixture | chromium | 4 | 1378 | 1549 |
| z9 | chromium | 5 | 1313 | 1564 |
| fixture | webkit | 5 | 3887 | 4086 |
| z9 | webkit | 5 | 2129 | 2611 |

Bar is 1500 ms p95. Still above on every cell. Stopped. No second latency pass.

Negative `playlistToSeg0` is the first seg0 response ending before the post-navigation playlist request (prefetch). `clickToAction` under 50 ms is a different POST than publish; the painted clock is still the rVFC clock.

WebKit fixture is dominated by click-to-navigation (about 2.9-3.4 s), not seg0. Chromium after the prefetch is about 1.3-1.6 s, with the remaining miss in navigation plus occasional late paint.

## Merged E2E

Evidence: `/srv/styrir/scratch/cap-fzp-8-wire/build-e2e/evidence-merged/`.

| Row | Source | Browser | Result | Measured | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | fixture | chromium | PASS | prepare 869 ms, Done enabled, 972 cuts | fixture-chromium-1.png |
| 1 | fixture | webkit | PASS | prepare 1493 ms, Done enabled | fixture-webkit-1.png |
| 1 | z9 | chromium | PASS | prepare 539 ms, Done enabled, 24 cuts | z9-chromium-1.png |
| 1 | z9 | webkit | PASS | prepare 616 ms, Done enabled | z9-webkit-1.png |
| 2 | fixture | chromium | PASS | click-to-frame 820 ms, overlay 0, stamp id 4 | fixture-chromium-2.png |
| 2 | fixture | webkit | PASS | click-to-frame 1689 ms, overlay 0, stamp id 4 | fixture-webkit-2.png |
| 2 | z9 | chromium | PASS | click-to-frame 798 ms, overlay 0, duration 109.733 | z9-chromium-2.png |
| 2 | z9 | webkit | PASS | click-to-frame 1299 ms, overlay 0, duration 109.733 | z9-webkit-2.png |
| 3 | fixture | chromium | PASS | playlist 200, private no-store, statuses 200/206 | fixture-chromium-3.png |
| 3 | fixture | webkit | PASS | playlist 200, private no-store, statuses 200/206/0 | fixture-webkit-3.png |
| 3 | z9 | chromium | PASS | playlist 200, private no-store, revision 73f015f5… | z9-chromium-3.png |
| 3 | z9 | webkit | PASS | playlist 200, private no-store, statuses 200/206/0 | z9-webkit-3.png |
| 4 | fixture | chromium | PASS | early 30 ms at 14.84 s, join 528 ms at 37.11 s, late 503 ms at 667.93 s | fixture-chromium-4.png |
| 4 | fixture | webkit | PASS | early 32 ms at 14.36 s, join 91 ms at 36.72 s, late 40 ms at 667.93 s (readyState 1) | fixture-webkit-4.png |
| 4 | z9 | chromium | PASS | early 65 ms at 2.19 s, join 58 ms at 5.49 s, late 1171 ms at 98.76 s | z9-chromium-4.png |
| 4 | z9 | webkit | FAIL | early 57 ms at 2.12 s, join 22 ms at 5.43 s, late stall 15024 ms and stopped at 22.32 s (duration 109.73 s) | z9-webkit-4.png |
| 5 | fixture | chromium | PASS | reload and embed kept a8fb94ce… | fixture-chromium-5.png |
| 5 | fixture | webkit | PASS | reload and embed kept a8fb94ce… | fixture-webkit-5.png |
| 5 | z9 | chromium | PASS | reload and embed kept 73f015f5… | z9-chromium-5.png |
| 5 | z9 | webkit | PASS | reload and embed kept 73f015f5… | z9-webkit-5.png |
| 6 | fixture | chromium | PASS | clock 00:00 / 00:05 / 00:30, duration 742.142 | fixture-chromium-6.png |
| 6 | fixture | webkit | PASS | clock 00:00 / 00:05 / 00:30, duration 742.142 | fixture-webkit-6.png |
| 6 | z9 | chromium | PASS | clock 0:00 / 0:05 / 0:30, currentTime 0 / 5 / 30 | z9-chromium-6.png |
| 6 | z9 | webkit | FAIL | at +5 s the clock still read 0:00 while currentTime was 5. At +30 s the clock read 0:30 and currentTime was 30. Duration 109.733 | z9-webkit-6.png |
| 7 | fixture | chromium | PASS | UI pill opened the share dialog. Public playlist 200. Private pill "Only you". New viewer `POST /api/media/grant` 403. In-flight next segment `seg/20.m4s` 410. Password pill "Anyone with the password". Viewer entered the password and playlist returned 200 | fixture-chromium-7-*.png |
| 7 | z9 | chromium | PASS | same sequence: grant 403, seg/20.m4s 410, password playlist 200 | z9-chromium-7-*.png |
| 7 | fixture | webkit | FAIL | dialog, private, grant 403, and direct segment 410 passed. Password overlay filled, Access Video did not dismiss it, no playlist 200 | fixture-webkit-7-password-play.png |
| 7 | z9 | webkit | FAIL | grant 403 and direct segment 410 passed. Password play did not start | z9-webkit-7-password-play.png |
| 8 | fixture | chromium | FAIL | raw-preview 404, segment playlists 404, result.mp4 410, original 200 with no presign. mp4 and video are 302 then 200 `application/vnd.apple.mpegurl` (revision playlist, not a presign). preview 302 to host `0.0.0.0:3000` then 404 | row8.json |
| 9 | legacy | chromium | FAIL | `/edit` showed "Your edit is still processing". Done never appeared. Existing `video_uploads` row is phase=processing, mode=singlepart | legacy-chromium-9.png |
| 10 | z9 | chromium | PASS | 73f015f5… replaced by 3454f4b5…. Old playlist 410. Click-to-share 6267 ms | z9-chromium-10.png |
| 11 | z9 | chromium | PASS | origin already at 8 CPUs. Second edit 3454f4b5… replaced by 1a047c2c…. Old playlist 410. Click-to-share 6067 ms | z9-chromium-10.png |

Row 7 was driven from the audience pill `Sharing: … Click to manage access.`, which opens the dialog titled `Share <name>` with the public switch and the password switch. Screenshots are the `*-7-public-dialog.png`, `*-7-private-dialog.png`, `*-7-new-viewer.png`, `*-7-inflight.png`, `*-7-password-dialog.png`, and `*-7-password-play.png` files in the evidence directory. Audience was restored to public with no password afterward (`videos.public=1`, password null).

Row 4 and row 6 WebKit z9 values are measured. Origin fragment code was not changed for the VFR buffered-gap seek.

## Residuals

- Done-to-frame p95 is over 1.5 s on all four cells after one web pass. WebKit fixture is mostly click-to-navigation. Chromium is about 50-60 ms over, plus one fixture publish 500.
- WebKit password submit does not leave the Protected Video dialog.
- Legacy editor is blocked by an already-processing upload row.
- Old `/api/playlist?videoType=mp4|video` now serves the revision HLS playlist (200) instead of 404. Preview redirects at `0.0.0.0:3000`.
- z9 WebKit late seek still stalls 15.0 s and lands at 22.32 s. +5 s clock did not follow currentTime.
- Disposable MySQL needed the 0047 column and `origin_video` view before origin could read it.

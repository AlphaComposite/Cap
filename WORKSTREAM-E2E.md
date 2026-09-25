# Instant Finish end-to-end proof

Disposable project `capwire-e2e`. Compose file `/srv/styrir/scratch/cap-fzp-8-wire/build-e2e/compose.yml`. Host ports on 127.0.0.1: MySQL 32116, MinIO 32117/32118, origin health 32119, nginx 32120. Throwaway volumes. Secrets are in `secrets.env` (mode 600) and were not printed.

Next.js was `next build` then `next start` from this worktree (the build fit; `next dev` was not used). Nginx includes `deploy/nginx/cap-media-location.conf`, proxies `/` to the web container, and forwards origin port 3020 with socat. Origin image is built from `apps/instant-finish-origin`. Default container CPU quota is 2. The row 11 rerun recreated origin with quota 8 (`NanoCpus=8000000000`). Encoder `-threads` is still hardcoded to 4, so that quota change does not raise the ffmpeg thread count.

Seeded flagged owner, non-owner viewer, and unflagged owner. Gate fixture source is the 243-range synthetic file (1037.6s). z9 is `z9x58adx1ra8bm3` copied read-only (142.933s). Browsers: Playwright 1.61.1, Chromium 1228, WebKit 2311 (MSE/hls.js).

## Results

Cold fixture prepare, measured on the editor-open that returned 200 after the timeout fix: 190347 ms. Warm reopen of the same source: 1928 ms (Chromium) and 1483 ms (WebKit). Done was not rendered until that response; a timed-out prepare before the fix returned 500.

| Row | Source | Browser | Result | Key numbers | Screenshot |
| --- | --- | --- | --- | --- | --- |
| 1 | fixture | chromium | PASS | cold prepare 190347 ms, status 200, Done enabled, 242 cut clips | evidence/fixture-chromium-1.png |
| 1 | fixture | webkit | PASS | prepare 1483 ms, status 200, Done enabled, 32 visible clips | evidence/fixture-webkit-1.png |
| 1 | z9 | chromium | PASS | prepare 7570 ms, status 200, Done enabled | evidence/z9-chromium-1.png |
| 1 | z9 | webkit | PASS | prepare 784 ms, status 200, Done enabled | evidence/z9-webkit-1.png |
| 2 | fixture | chromium | PASS | click-to-new-frame 2600 ms, overlay 0, stamp id 4 (source frame at the join is 7) | evidence/fixture-chromium-2.png |
| 2 | fixture | webkit | PASS | click-to-new-frame 2087 ms, overlay 0, stamp id 4 | evidence/fixture-webkit-2.png |
| 2 | z9 | chromium | PASS | click-to-new-frame 2325 ms, overlay 0, media duration 141.408 vs source 142.933. Removed-range pixel compare was not run | evidence/z9-chromium-2.png |
| 2 | z9 | webkit | PASS | click-to-frame 1550 ms, overlay 0, played revision e8a35d26…, duration 112.992. Removed-range pixel compare was not run | evidence/z9-webkit-2.png |
| 3 | fixture | chromium | PASS | playlist 200, Cache-Control private, no-store, segment statuses 200/206, no result.mp4 / raw-preview / presign | evidence/fixture-chromium-3.png |
| 3 | fixture | webkit | PASS | playlist 200, Cache-Control private, no-store, statuses 200/206 (one cancelled request recorded as 0) | evidence/fixture-webkit-3.png |
| 3 | z9 | chromium | PASS | playlist 200, Cache-Control private, no-store, statuses 200/206 | evidence/z9-chromium-3.png |
| 3 | z9 | webkit | PASS | playlist 200, Cache-Control private, no-store, revision e8a35d26… | evidence/z9-webkit-3.png |
| 4 | fixture | chromium | PASS | early 470 ms at 14.9s, join 647 ms at 37.25s, late 971 ms at 670.6s | evidence/fixture-chromium-4.png |
| 4 | fixture | webkit | PASS | early 113 ms, join 141 ms, late 157 ms | evidence/fixture-webkit-4.png |
| 4 | z9 | chromium | PASS | early 1146 ms at 2.8s, join 1093 ms at 7.1s, late 1173 ms at 127.3s | evidence/z9-chromium-4.png |
| 4 | z9 | webkit | FAIL | early 29 ms at 2.19s and join 31 ms at 5.59s landed. Late stall 15023 ms and stayed at 5.7s instead of about 101s | evidence/z9-webkit-4.png |
| 5 | fixture | chromium | PASS | reload and embed kept the same revision | evidence/fixture-chromium-5.png |
| 5 | fixture | webkit | PASS | reload and embed kept the same revision | evidence/fixture-webkit-5.png |
| 5 | z9 | chromium | PASS | reload and embed kept 639e8ef3… | evidence/z9-chromium-5.png |
| 5 | z9 | webkit | PASS | reload and embed kept e8a35d26… | evidence/z9-webkit-5.png |
| 6 | fixture | chromium | PASS | shown 12:25 at 0s, +5s, and +30s. media.duration 745.1, which is the frame-quantized revision duration (spec sum 745.375). Clock resolution is 1s | evidence/fixture-chromium-6.png |
| 6 | fixture | webkit | PASS | shown 12:25, media.duration 745.1, current time followed 0s / 5s / 30s | evidence/fixture-webkit-6.png |
| 6 | z9 | chromium | PASS | shown 2:21, media.duration 141.408, current time 0s / 5s / 30s | evidence/z9-chromium-6.png |
| 6 | z9 | webkit | FAIL | total shown 1:52 matches media.duration 112.992. At +30s the clock still read 0:05 while media.currentTime was 30 | evidence/z9-webkit-6.png |
| 7 | fixture | chromium | FAIL | Sharing dialog never opened. See blockers. Password case not reached | evidence/fixture-chromium-7-dialog.png |
| 8 | flagged video | chromium API | PASS | raw-preview 404, playlist mp4 404, segment master/video/audio 404, video 404, preview 404, storage result.mp4 410. Storage original returned 200 with no presign redirect (owner stream, not a signed URL) | evidence/row8.json |
| 9 | legacy | chromium | PASS | Done left the editor. video_uploads row phase=processing, mode=singlepart, raw file key present. Render not required and not waited | evidence/legacy-chromium-9.png |
| 10 | z9 | chromium | PASS | R1 639e8ef3… replaced by R2 e8a35d26…. Old playlist 410. Click-to-share 7024 ms | evidence/z9-chromium-10.png |
| 11 | z9 | chromium | PASS | Container CPU quota 8. Second-edit click-to-share 6689 ms to R3 883f9c15…. Previous playlist 410. Comparable quota-2 second edit was 7024 ms. ffmpeg threads remain 4 | evidence/z9-chromium-10.png |

Screenshot directory: `/srv/styrir/scratch/cap-fzp-8-wire/build-e2e/evidence/`.

## Bugs fixed

- `6422eef9e8` fix: copy origin service auth into the image. Row 1. The origin container exited on import before prepare could run.
- `f9ee47ece4` fix: keep editor-open prepare from timing out or corrupting the mezzanine. Row 1. Overlapping prepares shared one temp file and left a mezzanine with no source bind (later opens 409). The web fetch also used undici's 300s headers timeout, which is shorter than a cold A1 encode (measured 190s after the fix; the first attempt died at the timeout and 500'd the editor).
- `a267f54c4e` fix: allow frame-snap drift between playlist duration and the edit spec. Row 2. The 243-range fixture's continuous spec is 745.375s and the frame-quantized playlist is 745.1s. The 0.05s fence rejected a correct encode. The playlist must still match the origin's own duration within 0.05s.
- `ff04d8be54` fix: reopen a published instant-finish edit from its intent spec. Row 10. Publish does not write `video_edits`, so a second Done sent the identity spec as `expectedEditSpec` and was rejected as another session.

Origin unit tests after these commits: `python -m unittest apps.instant-finish-origin.tests.test_origin`, 16 tests, OK, 6.680s. Web unit tests for the publication fence were not rerun in this pass.

## Blockers

Row 7. Two UI attempts failed. There is no control named "sharing options". The audience pill (`Sharing: Anyone with the link. Click to manage access.`) is visible on the owner share page, and clicking it did not open the public-link dialog or a switch within 10s. Screenshot: `evidence/fixture-chromium-7-dialog.png`. Grant 403, the unavailable state, mid-play 410, and the password case were not measured. The fixture `videos.public` column was 0 when first inspected and was set back to 1 before the second attempt; the pill then showed "Anyone with the link", and the dialog still did not open.

Row 4 and row 6 WebKit failures on z9 are measured FAILs, not blockers. Linux WebKit late seek did not land, and the displayed clock did not follow a 30s seek.

z9 rows 2 did not compare a decoded frame against a frame from a removed range. Fixture rows used the frame-id stamp.

## Teardown

```
docker compose --env-file /srv/styrir/scratch/cap-fzp-8-wire/build-e2e/secrets.env -p capwire-e2e -f /srv/styrir/scratch/cap-fzp-8-wire/build-e2e/compose.yml --profile web down -v
```

# WORKSTREAM-FIX2

Scored M-immediate p95 is over 1.5 s on three of four cells. Stop rule applied: no further latency passes, no VUI on/off WebKit row, no 11-row E2E rerun.

Clock: Done click to share-page rVFC mediaTime>0 on the new revision, muted autoplay, new cut each trial. Evidence: /srv/styrir/scratch/cap-fzp-8-wire/build-e2e/evidence-fix2/.

## Commits

- 59454aec51 fix: reuse source indexes and defer thumbnails
- 07b1f2af2e fix: skip publish prepare and feed the first fragments once
- 21b2dbb7b3 fix: type the prefetch loader casts
- 2c4b7c6d5f fix: ship the VUI module in the origin image

Not pushed. capwire-e2e recreated from this HEAD; mysql and minio volumes kept. Origin image capwire-e2e-origin. VUI env left unset.

## Fixes and tests

L1. Editor action refresh reuses a warm source row and does not POST source prepare. Origin build_audio_index returns the existing index when source_sha256 and index_sha256 match. Test: apps/web/__tests__/unit/fix2-latency.test.ts and apps/instant-finish-origin/tests/test_fix2.py.

L2. thumbnail.jpg is scheduled after the prepare response. Attestation thumbnailSha256 is "pending". Shared vector tests/vectors/attestation.json updated; bun and web verifiers passed. Pending JPEG is accepted by readback so a missing thumbnail does not revert CURRENT. Preview uses previewRedirectOrigin and refuses a 0.0.0.0 host.

L3. prepareVideoRevision allocates, prepares, and stores the signed attestation without flipping. publishInstantFinishRevision reuses a READY row when the MAC verifies and intentId matches; a tampered MAC throws and does not become CURRENT. Abandoned READY rows of an older generation are EXPIRED. Disposable-MySQL integration: reuse does one prepare POST then a flip with zero more; tampered MAC refuses. 8/8 integration tests passed.

L4. doneRoute waits until instant-finish state is known. Done stays disabled. saveVideoEdits runs only after enabled:false.

L5. Prefetched init/seg0/seg1 bytes stay in an in-memory map keyed by pathname+search. hls.js loader serves that buffer and does not persist grants. Unit test: one load, no second network call.

E1. passwordCookieSecure is true only when WEB_URL is https. Unit test covers both schemes. WebKit row 7 was not rerun.

E2. Preview Location host comes from previewRedirectOrigin(WEB_URL, request, host), never 0.0.0.0. Unit test covers Host 127.0.0.1 and Host 0.0.0.0.

E3. Flagged mp4/video/master/audio alias test expects 302 to the current revision playlist and no presign. No publication is 404 with no Location. 401 and 403 have no Location.

E4. Not executed. Stub only: /srv/styrir/scratch/cap-fzp-8-wire/build-e2e/seed-row9.sh. e2elegacy000001 was not mutated.

E5. Seek-clock poll starts from the store seeking listener and from watchElementClock when currentTime changes without seeked/timeupdate. Sticky sample clears when the element reverts. Unit test passed.

V1. ORIGIN_H264_VUI_TICK_RATE unset leaves encoder bytes. A set value such as 10/1 runs ffmpeg h264_metadata and splices equal-length SPS NALs back so timestamps are not remuxed. Default unset. Not measured on Linux WebKit.

H1. measure.mjs keys clickToAction on the last action POST with body > 1024 bytes, and seg0End on the last seg0 response. CAPMM_SETTLE_MS is 50 for immediate and 2000 for settled. A trim drag is the last edit before that wait.

## Gates

- tsc -b apps/web: 0 errors
- biome on the touched TS files after the hook fix: clean
- vitest revision/segment-playlist/share-playback/video-edit/save-video-edits/instant-finish/password/preview: 220 passed, 8 skipped, then the integration file alone 8/8 with disposable MySQL on 127.0.0.1:35116
- bun test apps/instant-finish-origin/tests: 21 pass
- ORIGIN_IMAGE=capwire-e2e-origin unittest discover: 38 tests OK

## Migration

0047_brown_spitfire is the drizzle migration for the revision tables. Production gets it from the normal migrate/db:push deploy, not from hand SQL. The integration test ran that migrate on a fresh database and passed. origin_video is the DEFINER view in apps/instant-finish-origin/sql/origin-readonly.sql. That file is the integrator path for a disposable database; production needs an operator to apply it with a SELECT-only credential. The e2e database already has edit_revision and origin_video. It has no __drizzle_migrations journal.

## M-immediate (scored)

n=5, new revision 5/5 every cell. ms, click to painted frame.

fixture/chromium p50 1247 p95 1536 raw 1536, 1255, 1084, 1247, 1112
fixture/webkit p50 2761 p95 4018 raw 4018, 2705, 2724, 2761, 2838
z9/chromium p50 1227 p95 1306 raw 1306, 1227, 1199, 1130, 1230
z9/webkit p50 1624 p95 1765 raw 1613, 1765, 1761, 1514, 1624

Phase p95 (clickToAction, actionToNav, navToPlaylist, playlistToSeg0, seg0ToPainted):

fixture/chromium 940, 395, 79, -434, 791. Action status 500, 200, 500, 200, 500.
fixture/webkit 2872, 736, 104, 54, 1098. All 200.
z9/chromium 717, 384, 66, 72, 644. Action status 500, 500, 500, 500, 200.
z9/webkit 921, 636, 71, 103, 796. All 200.

Dominant phase is clickToAction. Fixture WebKit p95 2872 ms is most of the 4018 ms paint. Chromium often records a 500 on the large action POST the harness selected, so that phase is not a clean successful publish. playlistToSeg0 is negative on most trials: the chosen seg0 response ended before the playlist request, so that split is not the player's append wait.

## M-settled (informational, 2 s after the last drag)

fixture/chromium p50 817 p95 827 raw 786, 827, 729, 824, 817. All 200.
fixture/webkit p50 1786 p95 2134 raw 1828, 1180, 1786, 1528, 2134. All 200.
z9/chromium p50 845 p95 913 raw 845, 871, 688, 749, 913. All 200.
z9/webkit p50 1062 p95 1246 raw 1000, 1046, 1106, 1246, 1062. All 200.

Settled clickToAction drops to about 150-210 ms on Chromium and z9 WebKit. Fixture WebKit clickToAction p95 stays 1104 ms, and seg0ToPainted p95 stays about 1 s. Pre-click reuse helps Chromium. It does not bring fixture WebKit under 1.5 s.

## E2E

Not rerun. Stop rule after the scored p95 miss. Row 4/6 z9 WebKit with VUI unset and 10/1 was not measured.

## Residuals

- Scored gate missed. Do not treat M-settled as the score.
- Chromium immediate 500s on the large POST need a log read before another latency pass.
- Harness seg0End can still be a response that finished before navigation.
- VUI 10/1 not measured. Default remains unset.
- Row 9 seed not applied. Row 7 WebKit password not rerun.

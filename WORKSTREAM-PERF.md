# Origin perf — wire/perf-origin

Base c47460a891. No push. Production containers and capwire-e2e were not touched. No compose stack was started. Image left locally as `capperf-origin:wire` (`docker rmi capperf-origin:wire` to drop it).

Playback numbers are hls.js against a local playlist of the republished z9 edit (57 segments, 112.992s), not a Done click. Click-to-navigation is the web workstream. First painted frame is rVFC with mediaTime>0, muted autoplay, playlist already on disk.

## 1. Fragment alignment and TARGETDURATION

- `lib_audio.py:996` `align_audio_timing`: each fragment's audio tfdt and sample-duration sum match the video fragment in seconds. The old +1024 elst bias is not added to tfdt. WebKit MSE was applying that bias and opening a 21ms hole at every boundary.
- `lib_audio.py:1215` init elst media_time is 0 so an elst-aware player does not shift a timeline that is already at presentation time.
- `lib_origin.py:343` EXT-X-TARGETDURATION is ceil, not round.
- `lib_origin.py:437` tfhd default_sample_duration is at least the longest sample. Measured: this does not close WebKit's long-hold gaps. Left in because a shorter default is wrong; not claimed as the seek fix.
- Test: `tests/test_perf_origin.py` PlaylistTests, AlignmentTests, TfhdTests. Fails before (round target, PCM rebuilt, threads ignore ORIGIN_CPUS). Passes after.
- Oracle: `test_243_range_oracle` still 22378 frames, 242 joins, duration_ticks 11444224. No removed frame. Audio payloads are not dropped; only trun timing changed.
- z9 after, 57/57 segments: audio/video presentation delta 0.0 ms. TARGETDURATION 3, max EXTINF 2.108s (before, round produced 2 while EXTINF exceeded 2).

WebKit seek, hls.js, 3 runs, same edit. Before (scout-f, share page): after early+join, 9-10 gapped ranges from 6.1s; one late seek stalled 15.0s and stopped at 21.1s.

After:

- Chromium buffer: 1 range through 24.7-26.7s, plus the late range. 2 ranges. Late seek 34/39/50 ms, currentTime 101.693-101.696 vs 101.692.
- WebKit buffer: still 9 ranges in the first 8.6s, 15 after the late seek. Not 1-2.
- WebKit late seek did land: 58/74/79 ms, currentTime 101.694-101.715 vs 101.692-101.715. That is the scout failure, and it is fixed.
- WebKit early/join: currentTime matched (2.26, 5.65) but the `seeked` event did not fire within 8s. The harness timeout is 8s, not a measured 8s stall.

The remaining holes start at 6.100s, which is the 2048-tick (0.133s) VFR hold at output 6.067s, then one sliver per later hold of 2048-3072 ticks. Setting tfhd default to 3072, adding zero composition offsets, and splitting holds into zero-size padding samples did not make the range continuous (padding made it worse and was reverted). WebKit is not honoring those container fields for `video.buffered`.

## 2. Signed prepare attestation

- `server.py:242` body includes initSha256, seg0Sha256, playlistSha256, decodedFrames, playlistHasEndList, intentId, durationSeconds, segmentCount, captionsSha256, chaptersSha256, thumbnailSha256.
- `server.py:576` / `service_auth.py:98` header `x-cap-origin-attestation` is HMAC-SHA256 of the canonical body (sorted keys, trailing newline), same secret as the request MAC.
- Vector: `tests/vectors/attestation.json`. `tests/test_perf_origin.py` AttestationTests and `tests/attestation-vectors.test.ts` both check it. bun test: 21 pass.

## 3. seg0/init memory and mezz index

- `lib_origin.py:1042` first public ensure returns the prepare in-memory bytes when the bound file is still present. A missing sidecar still falls through and can 500, so a corrupted cache is not hidden.
- `lib_origin.py:820` `cached_mezz_index` keeps probe, packet table, and mezz sha. A new spec does not demux again.
- Before: scout ctor 118ms (probe 80ms); a second Origin() on this host was ~52ms. After: first ctor 147.6-171.5ms (one probe), second spec 2.0-2.3ms, `probe_calls` 1. seg0 ensure after `ensure_init` 0.06ms (in memory). Cold segment encode p50 385ms, p95 666ms — not the first-frame path.

## 4. PCM reuse and prepare label

- `lib_audio.py:269` skips the ffmpeg decode when the PCM and prep record match the source sha.
- Before: both editor-opens decoded, 429ms then 401ms (prepare_ms 308 / 288). After: reuse 8.3ms then 0.05ms, `reused: true`.
- `index.py:204` `prepare_ms_source` is `mezzanine`. Legacy `stss` records still load (`keyframe_source`).
- Upload-time trigger: `deploy/origin-prepare.md`. A1 stays an editor-open fallback.

## 5. ORIGIN_CPUS

- `limits.py:87`, `mezzanine.py:32`, `lib_origin.py` jit `-threads`. Env wins, else cgroup quota, else 4.
- z9 mezzanine, this host, one build at a time, quota 800% so 8 threads are not capped at 3:
  - 2 threads: 18.450s
  - 4 threads: 13.644s
  - 8 threads: 12.960s
- Before: encoder threads hardcoded at 4. Scout-e 4-thread z9 g1-vfr was 15.44s on an earlier host. The 2-vs-4 gap is the thread change. 8 vs 4 is 0.7s on this file.

## First painted frame (playlist ready, not Done click)

z9 only. Fixture browser Dones were not run here (745s, web click path). Five cold loads each.

- Chromium rVFC: 115, 128, 128, 133, 279 ms. p50 128, p95 279. mediaTime 0.033.
- WebKit rVFC: 235, 238, 240, 246, 316 ms. p50 240, p95 316. mediaTime 0.033.

## Gates

- origin unittest discover, `ORIGIN_IMAGE=capperf-origin:wire`: 34 tests, OK, including `test_server_imports_in_built_image` and the 22378/242 oracle. One skip only when the image env is unset.
- `bun test` grant-vectors + attestation-vectors: 21 pass.
- web vitest `revision- segment-playlist share-playback video-edit save-video-edits instant-finish`: 207 passed, 6 skipped, 17 files passed, 1 skipped. Used a node_modules symlink to the integration tree, removed after. This worktree has no install.
- `next typegen` ran. `tsc -b apps/web` failed by following that symlink into `../cap-fzp-8-wire-integration/packages/**` (TS5097 and existing package errors). No apps/web file in this diff. Not treated as an origin regression.

## Residual

WebKit `video.buffered` on z9 is still gapped at VFR holds longer than about 0.1s (first hole 6.100s, 2048-tick frame). Late seek lands. Early/join `seeked` does not. Container A/V durations match. A full Done-click p95 was not measured; that clock is the web builder's path.

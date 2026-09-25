# W-B origin

Branch `wire/b-origin` off `a17a3348fa`. Private Python/PyAV origin, A1 mezzanine, D4 warm, grant verification, additive compose service, nginx location artifact. Not a section 9 pass. Not deployed.

## Built

- `apps/instant-finish-origin/Dockerfile`
- `apps/instant-finish-origin/requirements.lock` (av 18.1.0, numpy 2.2.6, boto3 1.35.90, PyMySQL 1.1.1; confirmed with `pip show` in the smoke image)
- `apps/instant-finish-origin/entrypoint.sh` (umask 077, cache dir 0700)
- `apps/instant-finish-origin/server.py`
- `apps/instant-finish-origin/lib_origin.py`
- `apps/instant-finish-origin/lib_audio.py`
- `apps/instant-finish-origin/mezzanine.py`
- `apps/instant-finish-origin/index.py`
- `apps/instant-finish-origin/storage.py`
- `apps/instant-finish-origin/grant.py`
- `apps/instant-finish-origin/publication.py`
- `apps/instant-finish-origin/tests/test_origin.py`
- `apps/instant-finish-origin/docker-compose.smoke.yml` (project `capwire-b-origin`, loopback 3116/3117/3118/3119)
- `apps/instant-finish-origin/smoke/nginx.conf`
- `apps/instant-finish-origin/smoke/run_smoke.py`
- `apps/instant-finish-origin/sql/origin-readonly.sql`
- `apps/instant-finish-origin/sql/smoke-projection.sql`
- `deploy/nginx/cap-media-location.conf` (not installed into `/etc`)
- `docker-compose.yml` additive `instant-finish-origin` service and `instant-finish-origin-cache` volume only. Host publish `127.0.0.1:3020:3020`, cpus 2, mem_limit 2g, healthcheck `/health`.

## Contract stubs (integrator replaces; do not rename exports)

- `apps/web/lib/revision-media-token.ts` — `// CONTRACT STUB (owned by W-D)`. Encoding the origin verifies: `base64url(canonical UTF-8 JSON).base64url(HMAC-SHA256(secret, payload))`, sorted keys, no whitespace, claims `v,videoId,revisionId,publicationEpoch,policyEpoch,iat,exp,grantId`, TTL 60s, iat skew 5s. Exports: `REVISION_MEDIA_GRANT_TTL_SECONDS`, `REVISION_MEDIA_GRANT_SKEW_SECONDS`, `RevisionMediaGrantClaims`, `canonicalRevisionMediaGrantJson`, `mintRevisionMediaToken`, `verifyRevisionMediaToken`.
- `apps/web/lib/revision-publication.ts` — `// CONTRACT STUB (owned by W-A)`. Read-only shapes: `PublicationProjection`, `RevisionProjection`, `SourceObjectProjection`, `RevisionPrepareResult`.

## Behavior

- A1 at source prepare, not Finish: same geometry, libx264 veryfast CRF18, `-bf 0`, forced IDR every 1s, `-fps_mode passthrough`, AAC copy, source video timescale kept, stss index. No B-frames on the mezzanine. Missing mezzanine on revision prepare is 409 `mezzanine_required`, not an original-path encode.
- JIT segment encode keeps the gated PyAV x264 options. Timescale and geometry come from the probed source. Encoder hash includes those, so a 1/15360 1670x1080 namespace is not a 1/16000 namespace. A legacy hash without that identity is refused.
- Audio: 48 kHz stays on the gated presentation path. 16 kHz is resampled. Any other rate is 409 `audio_rejected`. Removed presentation samples are refused before encode. AAC tfdt bias remains 1024; segment 0 leading overlap is tfdt 0.
- D4 `warm_for_source` is keyed by source id, logs open/evict with TTL, and expires. Cache layout is `ns/{mezz_sha}/{audio_sha}/{rev}/{encoder_hash}`, directories 0700, files 0600. Serve uses the bytes just produced. A bad encoder sidecar is regenerated once. No request-path syncfs. No public source route, no `result.mp4` route. `download.mp4` is 202 until a revision MP4 exists. A full MP4 is not built before revision prepare 200.
- Public `GET|HEAD|Range` under `/media/{videoId}/r/{revisionId}/...`. Playlist children are relative and carry the same `?t=`. 200/206 send `Cache-Control: private, no-store` and `Accept-Ranges`. Invalid grant 401, wrong video/revision 403, non-current or epoch mismatch 410, regenerate failure 500. Epoch is read again before the body is sent.
- Internal prepare requires `X-Origin-Service-Token`, distinct from the grant secret. Source prepare body is `{sourceId, sourceKey}`. Revision prepare body is `{videoId, sourceId, keepRanges, captions?, chapters?}`. Flip payload is `{ready, intentId, durationSeconds, durationTicks, segmentCount, seg0DecodedFrames, encoderHash, segmentPlanVersion, playlistHasEndList}`. Origin never writes MySQL.

## Commands and results

Venv used for host tests: `/srv/styrir/scratch/cap-fzp-8-wire/build-b-origin/venv` (not committed). Image pins were checked inside the smoke container, not by trusting `__version__` on PyMySQL (that attribute is 1.4.6 while the installed distribution is 1.1.1).

1. `systemd-run --user --unit capwire-b-origin-testfinal --collect --wait -p MemoryMax=6G -p CPUQuota=300% -p WorkingDirectory=/srv/styrir/worktrees/cap-fzp-8-wire-b-origin -- /srv/styrir/scratch/cap-fzp-8-wire/build-b-origin/venv/bin/python -m unittest apps.instant-finish-origin.tests.test_origin -v`
   Exit 0. `Ran 16 tests in 7.691s` / `OK`.
   Contention line: `SEG0 ensure_ms=504.661 duration_s=0.16666666666666666 aac_miss=True`.
   Covered: VFR 1/15360 and 1/16000 planning, 243-range oracle (22378 frames, 11444224 ticks, 242 joins, 745.0666666666667s), stss mezzanine, no B-frames, source SHA distinct from mezzanine SHA, 16 kHz resample, old encoder-hash refusal, warm expiry, removed-sample refusal, AAC tfdt 0/1024, HEAD/Range/no-store, 401/403/410/500, epoch flip before send, no original or result.mp4 route, 0.15s seg0.

2. `systemd-run --user --unit capwire-b-origin-compose --collect --wait -p MemoryMax=6G -p CPUQuota=300% -p WorkingDirectory=/srv/styrir/worktrees/cap-fzp-8-wire-b-origin -- docker compose -p capwire-b-origin -f apps/instant-finish-origin/docker-compose.smoke.yml up -d --build --wait`
   Exit 0. Runtime 1min 30s. Services came up healthy on 127.0.0.1 only: mysql 3116, minio 3117, nginx 3118, origin 3119.

3. `systemd-run --user --unit capwire-b-origin-smoke2 --collect --wait ... python apps/instant-finish-origin/smoke/run_smoke.py`
   Exit 0 after the decode-count rebuild. Key lines:
   `origin_health=200`
   `source_prepare=200` `source_timescale=15360 bframes=False`
   `revision_prepare=200` `revision_ready=True segs=2 seg0_frames=5 duration_s=0.6`
   `nginx_playlist=200 cache=private, no-store endlist=True child_grant=True`
   `nginx_playlist_has_source_key False`
   `nginx_init_head=200 length=1203 cache=private, no-store`
   `nginx_seg0_range=206 cr=bytes 0-15/9391 nbytes=16 cache=private, no-store`
   `nginx_missing_grant=401`
   `nginx_seg0=200 nbytes=9391`
   `decoded_seg0_frames=5`
   Cache directories in the container were mode 0700 and files 0600. Hash path components are omitted here.

4. Chromium headless (`/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome --headless=new`) loaded `http://127.0.0.1:3118/player/` and appended init plus seg0 through MediaSource (`avc1.640028,mp4a.40.2`, `MediaSource.isTypeSupported` true). Observed: playlist 200, endlist, child grant present, init 1203 bytes, seg0 9391 bytes, `playCalled readyState=1 size=320x180`. `loadeddata` / `playing` did not appear before `dump-dom` returned. PyAV decoded 5 frames from those same bytes. This is not a painted-frame browser timing.

5. `/srv/styrir/apps/cap/node_modules/.bin/biome check --write` on the two stub files. Exit 0. Fixed formatting only.

Earlier failing runs, fixed before the final suite: mezzanine temp name was not an mp4; `ensure_init` produced segment 0 without recording a miss; decode check stopped at 1 frame; a forced 500 ran while the publication epoch was still flipped. Those are not the acceptance result.

## A / C / D handoff

A calls, with the service token, not the public grant:

- `POST /internal/sources/{videoId}/prepare` body `{sourceId, sourceKey}` where `sourceKey` is the immutable original object key. Not `result.mp4`, not a presigned URL.
- `POST /internal/revisions/{revisionId}/prepare` body `{videoId, sourceId, keepRanges, captions?, chapters?}`. Do not mark CURRENT until this returns 200 and `seg0DecodedFrames >= 1`, `playlistHasEndList` is true, and `intentId` is stored on the revision row. Origin compares `edit_revision.intentId` to the cache namespace on every public read.
- Tables the origin SELECTs, and never writes: `videos(id, public, password, bucket)`, `video_publication(videoId, currentRevisionId, generation, publicationEpoch, policyEpoch)`, `edit_revision(revisionId, videoId, intentId, sourceId, generation, state)`, `source_object(videoId, liveKey, sha256, relocationState)`. `videos.bucket` NULL is the default bucket. A non-null bucket id is 403. State must be `CURRENT` or `READY`, and `video_publication.currentRevisionId` must match.
- `sql/origin-readonly.sql` is a SELECT grant sketch with password `replace-me`. Apply it only on a disposable database after A's migration. Do not run it on production.

D mints with the shared grant secret. Origin verifies. Service token must differ and be at least 32 bytes. No owner header is trusted. Privacy changes must bump `policyEpoch` or delivery fails closed. A changed epoch during an in-flight request returns 410 and does not send the body.

C plays same-origin `/media/{videoId}/r/{revisionId}/playlist.m3u8?t=...`. Children in the playlist already include `?t=`. Insert `deploy/nginx/cap-media-location.conf` before `location /` on the cap web server only. `proxy_pass http://127.0.0.1:3020`, `proxy_cache off`, no new tunnel host. Nginx in the smoke stack also adds `Cache-Control`, so the header can appear twice. That is still `private, no-store`.

This worktree's `docker-compose.yml` was the clean `a17a3348fa` file. The production checkout's uncommitted image-pin/env/loopback diff was not present here and was not overwritten. Merge the additive service onto that dirty diff later.

## Known gaps

- Section 9 was not run and is not claimed. The 504.661 ms figure is one local 320x180 fixture segment under a competing thread, with an emptied AAC pool. It is not the six-video census, not 20 cold trials, and not a p95.
- WebKit was not run. No WebKit browser is installed under `/root/.cache/ms-playwright` (Chromium only). Chromium did not reach `readyState >= 2` before headless `dump-dom` returned.
- Gate tone sentinel / order / A-V offset suite was not re-run. The unit test checks tfdt and that a removed presentation sample deletes the destination and raises. It does not measure a sentinel frequency.
- Process-cold (new process, empty pool, no prior warm in that process) was not separated from the in-process `reset_aac_pool()` miss above.
- `download.mp4` stays 202. No revision MP4 is produced.
- Disposable stack `capwire-b-origin` was still up at the end of this run (mysql 3116, minio 3117, nginx 3118, origin 3119, all 127.0.0.1). `docker compose ... down -v` and `docker stop` were blocked by the local command policy in this session. Tear it down before the next heavy job: `docker compose -p capwire-b-origin -f apps/instant-finish-origin/docker-compose.smoke.yml down -v`.
- `/etc/nginx` was not edited. Production containers, the live database, and live MinIO were not used.

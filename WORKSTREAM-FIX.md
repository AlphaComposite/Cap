# Origin review fixes (wire/fix-origin)

Baseline: `dc30f6674a`. Ownership: `apps/instant-finish-origin/**`, `deploy/nginx/**`, the `instant-finish-origin` service block in `docker-compose.yml`, and `apps/web/lib/revision-media-token.ts` (F8 only). Migration `0047` column add stays with fix-web. Disposable project `capfix-origin` was removed with `docker compose -p capfix-origin -f apps/instant-finish-origin/docker-compose.fix.yml down -v`.

## F1 image imports and nginx smoke

Changed: `apps/instant-finish-origin/Dockerfile:15` copies `service_auth.py` and `limits.py` with the other modules. `apps/instant-finish-origin/tests/test_image_import.py` imports `server` inside `ORIGIN_IMAGE`.

Before: `docker run --entrypoint python3 capfix-origin-before:f1 -c 'import server'` exited 1, `ModuleNotFoundError: No module named 'service_auth'`.
After: `ImageImportTests.test_server_imports_in_built_image` ok. Disposable stack (MySQL with `0047_brown_spitfire.sql` plus a local `currentGeneration` column, MinIO, nginx including `deploy/nginx/cap-media-location.conf`) reported `image_import import-ok`, origin healthcheck healthy, nginx source prepare 200, revision prepare 200, playlist 200, init 200, seg0 Range 206.

Residual: the image still has no `cryptography` package. The disposable MySQL user is `mysql_native_password` so PyMySQL can connect. A caching_sha2 user will fail until that plugin or package changes.

## F5 serving generation

Changed: `apps/instant-finish-origin/publication.py:59` reads `p.currentGeneration`, not `p.generation`, as the serving generation. `apps/instant-finish-origin/server.py:308` rejects playback unless `rev.generation == pub.current_generation` and `pub.currentRevisionId == revisionId`. Allocated `generation` can move ahead.

Before: `python -m unittest apps.instant-finish-origin.tests.test_fix_contract` on `dc30f6674a` exited 1 (`currentGeneration` was not part of the authorize snapshot).
After: `CurrentGenerationTests.test_allocated_r2_leaves_r1_playable` ok. Disposable row was allocated generation 2 / currentGeneration 1 and R1 still played.

Residual: the column is not in committed `0047` here. If fix-web does not amend that migration, the origin GRANT and SELECT fail closed.

## F6 unprivileged read-only credentials

Changed: `Dockerfile:7-10,25` creates uid/gid 65532 and `USER 65532:65532`, cache mode 0700. `docker-compose.yml` sets `user: "65532:65532"` and `S3_ACCESS_KEY`/`S3_SECRET_KEY` from `ORIGIN_S3_*` with no root default. `deploy/minio/instant-finish-origin-policy.json` allows GetObject/ListBucket on `cap` only. `deploy/minio/setup-instant-finish-origin.sh` applies that policy. `sql/origin-readonly.sql` grants column SELECT plus `origin_video.has_password`; it does not grant `videos.password`.

Before: before-image config user was empty.
After: smoke `origin_uid=65532 cache=700 65532`. Origin DB user could read `has_password=1` and was denied `SELECT password`, INSERT, and UPDATE. Origin MinIO user write and other-bucket read were denied, and media still played.

Residual: the setup script shells out to `minio/mc` when `mc` is not installed, and the alias must be an `MC_HOST_` identifier (no hyphen).

## F7 media log and referrer

Changed: `deploy/nginx/cap-media-location.conf:5,17-22` sets `access_log off`, `proxy_cache off`, `private, no-store`, and `Referrer-Policy no-referrer`. `deploy/nginx/README-instant-finish.md:16-26` documents the Cloudflare bypass rule for `/media/*`. It was not applied. Origin responses set the same referrer at `server.py:282`.

Before: contract test failed on `dc30f6674a` because media responses did not send `Referrer-Policy`.
After: `HeaderAndLimitTests.test_media_sets_referrer_policy` ok. Nginx playlist was `referrer=no-referrer cache=private, no-store`. Copied nginx `other.log` had no `t=` and no `playlist.m3u8` (`nginx_access_log=no_bearer`).

Residual: Cloudflare can still cache `/media/*` until an operator adds the documented bypass rule. This change does not call Cloudflare.

## F8 shared grant and service vectors

Changed: `tests/vectors/grant-service.json` is consumed by `tests/test_fix_contract.py` and `tests/grant-vectors.test.ts`. `grant.py` rejects unsafe integers, bad ids, and `now > exp + skew`. `service_auth.py:87` and `apps/web/lib/revision-media-token.ts:338` require `exp - iat == 30`.

Before: `bun test apps/instant-finish-origin/tests/grant-vectors.test.ts` exited 1 before the TTL/safe-integer alignment. Python contract tests exited 1 on skew, unsafe integers, bad ids, and service TTL.
After: bun test 19 pass, exit 0. `GrantVectorTests` and `ServiceVectorTests` ok, including `test_signer_ttl_is_thirty`.

Residual: vectors use disposable test keys, not production secrets. A signer that emits a non-30 service TTL is rejected on both sides.

## F9 bounds

Changed: `limits.py` caps inflight, duration, resolution, source bytes, keep-range count, decoder cache, and ffmpeg timeouts. `server.py:771` `BoundedHTTPServer` returns 503 with `Retry-After` when full. Range reads do not load the whole segment. Garbage media returns 400. Decoder and warm-log caches are size-capped. ffmpeg/ffprobe calls in `mezzanine.py`, `lib_origin.py`, and `lib_audio.py` have timeouts.

Before: contract tests on `dc30f6674a` exited 1 (unbounded handler, garbage media 500).
After: `test_overload_returns_retry_after` and `test_garbage_media_is_4xx` ok. Full origin unittest: 24 tests, exit 0.

Residual: overload is 503, not 429. A hung ffmpeg is killed at the timeout, but a hostile file that decodes slowly can still occupy a worker until that timeout.

## F11 pooled authorize and SHA identity

Changed: `publication.py:160` pools MySQL connections. Authorize is one SELECT (`publication.py:56`). Recheck before the body is the second, cheaper pooled SELECT (`publication.py:71`, `server.py:270`). `storage.py:27` caches SHA by `(key, etag, version, size)`. `server.py:386` reuses that identity for 30s so a warm playlist does not HEAD or rehash every segment. `S3ObjectStore` reuses one client.

Before: every source check hashed the local original, and the first after-build HEADed MinIO on every seg0 (warm p50 11.3 ms at 2 CPUs / 19.0 ms at 8).
After, disposable stack, n=30 seg0 each:

- CPUs=2 rehash=1 warm p50 3.1 ms p95 5.1 ms
- CPUs=2 identity-cache warm p50 2.8 ms p95 3.6 ms
- CPUs=2 identity-cache cold (segment file deleted) p50 24.8 ms p95 34.4 ms
- CPUs=8 rehash=1 warm p50 3.1 ms p95 4.5 ms
- CPUs=8 identity-cache warm p50 2.9 ms p95 4.7 ms
- CPUs=8 identity-cache cold p50 24.8 ms p95 32.9 ms

Residual: the fixture original is about 1 second, so skipping a full hash is only a few milliseconds. A replaced object is invisible to the identity memo for up to 30s; the authorize query still rejects a changed `source_sha256`. Cold here is a missing segment file, not a process restart.

## Suites

- `ORIGIN_IMAGE=capfix-origin:f1 python -m unittest discover -s apps/instant-finish-origin/tests -v` exit 0 (24 tests).
- `bun test apps/instant-finish-origin/tests/grant-vectors.test.ts` exit 0 (19 pass).
- `cd apps/web && bunx vitest run` on revision-*, segment-playlist*, share-playback, video-edit*, save-video-edits* exit 1: 163 passed, 4 failed, 6 skipped. Failures are `video-edit-processing.test.ts` importing `server-only` from a client render. `revision-media-auth.test.ts` passed (10). No `instant-finish*` vitest file exists in `apps/web`; the added TS vector test is the bun test above.
- `bunx next typegen && NODE_OPTIONS=--max-old-space-size=5120 bunx tsc -b apps/web --pretty false` exit 0.

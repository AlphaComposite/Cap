# Origin prepare and encoder threads

## Upload-time prepare

`POST /internal/sources/{videoId}/prepare` builds the A1 mezzanine, the stss keyframe index, the audio packet index, and the presentation PCM. Call it when the upload lands, with the same service MAC as other `/internal/` routes (`x-cap-origin-service`).

The body is `{ "videoId", "sourceId", "sourceKey" }`. A 200 response is the immutable source identity (`sha256`, `a1Digest`, `timebase`, `frameMode`, `warmExpiresAt`). Editor-open may still call this endpoint; A1 runs only when `mezz.mp4` or its source bind is missing. Do not wait for that fallback on the editor-open path once upload-time prepare is wired.

## Revision attestation

`POST /internal/revisions/{revisionId}/prepare` returns the decode attestation as the raw JSON body and signs those exact bytes in `x-cap-origin-attestation`.

The MAC is HMAC-SHA256 over the response body (sorted keys, Python `json.dumps` separators, trailing newline), base64url without padding, using `REVISION_ORIGIN_SERVICE_SECRET` — the same secret as `x-cap-origin-service`. Verify the raw body. Do not re-serialize it. The shared vector is `apps/instant-finish-origin/tests/vectors/attestation.json`.

The body includes `initSha256`, `seg0Sha256`, `playlistSha256`, `decodedFrames`, `playlistHasEndList`, `intentId`, `durationSeconds`, `segmentCount`, `captionsSha256`, `chaptersSha256`, and `thumbnailSha256`. `playlistSha256` is the grant-less playlist. The first public `init.mp4` and `seg/0.m4s` for that revision are served from the prepare process cache.

## ORIGIN_CPUS

x264 and ffmpeg `-threads` follow `ORIGIN_CPUS` (round half up, minimum 1). If it is unset, the process cgroup quota is used, then 4. Set it to the same value as the compose `cpus:` limit. `docker-compose.yml` passes `${ORIGIN_CPUS:-2}` into the origin service.

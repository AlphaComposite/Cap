# WORKSTREAM-SEC

Sol review cap-fzp.8.7.4, branch wire/sec. Ownership is B1, B2, B3, N1, N3, and N4. B4 and N2 were not touched.

## Findings

B1 isolate side artifacts. Commit 88f6c96dfa. Captions, chapters, and thumbnails are written under cache/revisions/<revisionId> and refused when the signed sha256 does not match. Test apps/instant-finish-origin/tests/test_side_artifacts.py. Origin unittest with ORIGIN_IMAGE=capsec-origin: 39 passed, including the image import.

B2 fail closed until relocation is PURGED. Commit d84dc646ee. Editor-open calls the shared relocator. Publish and prepare refuse an unrelocated liveKey. The CLI reuses that function and throws on a no-op. Unit test source-relocation-gate.test.ts. Disposable versioned MinIO on 127.0.0.1:36217: four old keys (original, raw, result.mp4, segment) were 200 before relocation and 404 on the preissued GET, HEAD, and Range after; old version count 0; publish gate refused before and accepted the private liveKey after. moved=4, liveKeyPrivate=true.

B3 durable readback. Commit 3f3d3821ba. The in-process timer is gone. A lease worker polls at 1.5s, sweeps stranded rows on startup, skips a readback that is no longer CURRENT, and does not retain completed promises. Disposable MySQL integration (capwire_b): 12 passed, including crash-between-flip, stale-current no-op, and two-worker single processing.

N1 CSRF. Commit 9c1271fa84. Content-Type essence must be application/json. Origin scheme and host are compared to WEB_URL, not X-Forwarded-Host. Missing and null Origin are rejected. Unit tests cover text/plain;x=application/json, http versus https, and a spoofed forwarded host.

N3 thumbnail status. Commit cb284b1162. The artifact row stays PENDING until a JPEG with SOF verifies and its sha is stored. Preview and OG serve a real placeholder, not the four-byte marker, while pending or failed. Unit test revision-thumbnail.test.ts.

N4 fragment cache. Commit d9c991c66c. The cache holds at most three startup fragments for one revision and deletes each entry on read. The session handoff key is removed on use or expiry.

Follow-up test commit a8b139d250 expects the purged liveKey in the fence.

## Gates

- vitest: revision route, fragment cache, relocation gate, thumbnail, playback handoff, fix-web, publish route, flag route, and password filters passed before the integration rerun.
- disposable MySQL integration: 12 passed.
- origin unittest discover with ORIGIN_IMAGE=capsec-origin (sha 65d7e4486aa6, built from this tree): 39 passed, 1 skipped.
- typegen (next typegen) and tsc -b apps/web: 0 errors.
- biome check --write on the changed files: clean except an unused deps parameter that was renamed.

## Residuals

Chromium Done on the synthetic fixture did not finish. next start was ready on 127.0.0.1:36220 and origin was healthy on 36219, but editor-open source prepare returned HTTP 500, so the Done button never appeared and the share page was not painted. A direct mezzanine build of the same object inside the origin container succeeded, so the 500 is in the HTTP prepare path, not the MinIO object. Playback end-to-end is not proven.

bun test apps/instant-finish-origin/tests was not a JS suite; the Python unittest above is the origin gate.

## Teardown

systemctl --user stop capsec-web
docker compose -p capsec -f /srv/styrir/scratch/capsec-fzp/compose.yml --env-file /srv/styrir/scratch/capsec-fzp/secrets.env down --remove-orphans
The secrets file remains at /srv/styrir/scratch/capsec-fzp/secrets.env mode 600 and was not printed.

## Completion pass

S1 root cause: editor-open prepare downloaded the relocated object and found a cached mezz `.source-bind.json` whose `source_sha256` did not match those bytes. The handler returned HTTP 500 body `unavailable` and did not log the exception type, which is why the capsec-web journal only said `Source prepare failed with HTTP 500` (21:29 and 21:35; the 21:27 409 was `mezzanine_required`). The mismatch return is now a rebuild in `apps/instant-finish-origin/server.py:170` (`_bound_mezzanine`); a still-mismatched bind returns 500 at line 194. A key that is not the recorded live key is 409 `source_key_mismatch`. Origin MinIO policy allows GetObject/GetObjectVersion only on the recorded `private/source/<videoId>/<opaque>` keys, plus ListBucket conditioned on those exact prefixes. Recorded policy: `/srv/styrir/scratch/cap-fzp-8-wire/sec-evidence/origin-policy.json`.

Follow-on blockers found while proving Done, each fixed at the cause:
- Next's patched fetch memoized the pre-delete GET, so the revocation probe still saw 200. Probe now uses node:http (`apps/web/scripts/instant-finish-relocate.ts`).
- A fixed 512-tick placeholder pts is one 30fps step only at timescale 15360. At 16000 the muxer reported `non monotonically increasing dts` and revision prepare returned 500. Step is now `timescale // 30` (`apps/instant-finish-origin/lib_origin.py`).
- The self-host proxy sent `/media` to `/login`, so the share page never loaded the playlist. `/media/` is allowlisted (`apps/web/proxy.ts`).

Commits after 8e58317465: cf9337ae8d, 261032ccd9, 655b823d5a, baa8410fdb, 2b8e8a0cf7, 4ebeadc929, e3e63bb3ba, 0fa2a622c4, baea860ad2.

Tests: relocated-key prepare failed in the origin image before the rebuild (HTTP 500 `unavailable`) and passed after. `test_16000_timescale_segment_muxes` covers the dts fix. Versioning OFF and ON purge: `/srv/styrir/scratch/cap-fzp-8-wire/sec-evidence/version-purge.json` (unversioned VersionId `"null"` still deletes the current object).

S2: Chromium and Playwright WebKit 2311. Open editor on a never-relocated fixture, relocation ran, Done appeared, share page painted the new revision from `/media` only (playlist, init, seg/0, seg/1 all 200). Chromium rVFC mediaTime 0.033312 before and after reload. WebKit rVFC mediaTime 0.066687 on first paint; reload click-to-play mediaTime 0.033312 in `webkit-reload.json`. Pre-editor presigned GET/HEAD/Range for original, raw, result, and segment are 404 after. Evidence: `/srv/styrir/scratch/cap-fzp-8-wire/sec-evidence/e2e.json` and the six `chromium-*.png` / `webkit-*.png` shots.

S3: Sec-Fetch-Site cross-site 403, same-site 403, same-origin pass, absent plus good Origin pass; non-default port is compared. Covered by `revision-route-guard.test.ts`.

S4: claim is a short transaction with `for("update").skipLocked()`, complete checks the lease token, attempts stop at 5 with an error log, revert requires CURRENT generation, and publish only inserts the outbox. Integration test `does not revert a readback killed during its lease until the lease expires` passed on disposable MySQL, not skipped.

Gates: vitest revision/save-video-edits/video-edit/instant-finish/fix2/source-relocation plus the new policy and route-guard files, 25 files, 204 passed. Disposable-MySQL integration 13 passed. Origin unittest discover ORIGIN_IMAGE=capsec2-origin:wire-sec (sha256:d6119849e8246757b725c7af54cbf5a08d5deb13e68e3fa82a84d946fbed4762), 41 tests, OK, 1 skipped. typegen then `tsc -b apps/web` with heap 6144, 0 errors. Biome on the changed files, clean.

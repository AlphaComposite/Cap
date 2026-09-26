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

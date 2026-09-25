# Instant Finish merge 2

Branch `wire/integration`. Parents before this pass: `ff04d8be54` (E2E fixes on `dc30f6674a`).

## Merge commits

1. `8a635d513e` merge: wire/fix-origin into wire/integration
   Parents: `ff04d8be54` + `bbba5a4538`
2. `e84bae0d9d` merge: wire/fix-web into wire/integration
   Parents: `8a635d513e` + `d4b450697f`
3. `4d999446c0` fix: align merged instant-finish timeouts, reopen, and share-page tests

Not pushed.

## Conflicts and resolution

Dockerfile (`apps/instant-finish-origin/Dockerfile`). Kept fix-origin: non-root uid/gid 65532, cache mode 0700, `USER 65532:65532`. COPY line includes `service_auth.py` and `limits.py` plus `grant.py`, `publication.py`, `storage.py`, `index.py`, `mezzanine.py`, `lib_audio.py`, `lib_origin.py`, `server.py`. Those are every local module the server imports. Image import test confirmed `import server, service_auth, limits, grant, publication`.

`server.py`. Combined both sides. E2E prepare lock (`_prepare_locks`, bind-before-ready, unique temp names in mezzanine) stayed. fix-origin SHA identity cache, admission, and referrer headers stayed. `_emit` keeps `Referrer-Policy` / `Cache-Control` defaults and the `BrokenPipeError` handler.

`mezzanine.py` auto-merged (unique temp path + `limits.run_cmd`). Follow-up replaced the fixed mezzanine timeout with a duration-derived bound. Cold A1 of a 1037s source took 190s. `timeout_for_duration(1037)` is 807.75s (`0.75 * duration + 30`, env `ORIGIN_MEZZ_TIMEOUT_S` is a floor, default 0). Full-file audio ffprobe/ffmpeg timeouts use the same bound. Probe-walk join scales with header duration and file size so an 8s cap does not reject the source before encode starts.

`revision-publication.ts`. Only the `finishMetadataSnapshot` import conflicted. Frame-snap tolerance (`snapAllowance = max(0.05, keepRangeCount / 24)`, plus the 0.05s origin attestation check) survived fix-web's publication changes.

`WORKSTREAM-FIX.md` was add/add. Both notes are kept, origin section then web section.

Migration `0047_brown_spitfire.sql` is fix-web's amended file (`currentGeneration`, `metadataSnapshot`). Journal tag `0047_brown_spitfire` was already present and was not rewritten. `drizzle-kit generate` reported no schema changes. `apps/instant-finish-origin/sql/origin-readonly.sql` grants `video_publication.currentGeneration` (fix-origin; survived). Generated `0047_snapshot.json` was not hand-formatted.

Reopen (`ff04d8be54`) now joins `videoPublication.currentGeneration` to the intent generation and the current revision, and the editor chapters come from `editRevision.metadataSnapshot` when that row exists. Allocated `generation` can move ahead of the serving revision; the old join would have followed it.

## server-only root cause

Commit `3f906db8af` (`feat: play flagged edits as revision HLS`), ancestor of `dc30f6674a`, not present on `a17a3348`. It added `apps/web/lib/revision-playback-load.ts` with `import "server-only"` and the share page import of `loadRevisionPlayback`. Client components under `app/s` do not import that loader. Vitest does not use the `react-server` export condition, so importing the share page throws "This module cannot be imported from a Client Component module". The other server-only imports on that page were already mocked in `video-edit-processing.test.ts`. The test does not exercise revision playback, so it now mocks `@/lib/revision-playback-load` the same way. The production `server-only` guard was not removed. This is not a client-bundle import of `server-only`.

## Suites

Disposable MySQL project `capmerge-int`, `127.0.0.1:34116`, torn down with `docker compose -p capmerge-int -f /srv/styrir/scratch/cap-fzp-8-wire/merge2/compose.yml down -v`. `capwire-e2e` and production `cap-web` / `cap-mysql` / `cap-minio` / `cap-media-server` were not touched. No `acl-*` test file exists.

- `cd apps/web && bunx vitest run` on the 17 files matching `revision-*`, `segment-playlist*`, `share-playback*`, `video-edit*`, `save-video-edits*`, `instant-finish*`, with `CAP_WIRE_A_DATABASE_URL` set to the disposable root user on `127.0.0.1:34116/capmerge`. Exit 0. 17 files passed, 208 tests passed, 0 failed, 0 skipped. Includes `video-edit-processing.test.ts` (8 passed) and `revision-publication.integration.test.ts` (6 fence tests, not skipped).
- `bun test apps/instant-finish-origin/tests/grant-vectors.test.ts`. Exit 0. 19 pass, 0 fail. Re-run after biome formatted the vector JSON.
- `ORIGIN_IMAGE=capmerge-origin:merged` (`sha256:d3ac0f626a330c9ff42ad4495ecda444711666e13c036d680a406f0efb5aba01`, built from the merged Dockerfile) `/srv/styrir/scratch/cap-fzp-8-wire/build-b-origin/venv/bin/python -m unittest discover -s apps/instant-finish-origin/tests`. Exit 0. 24 tests, OK, 10.051s. Includes `test_server_imports_in_built_image`.
- `cd apps/web && bunx next typegen && NODE_OPTIONS=--max-old-space-size=5120 bunx tsc -b apps/web --pretty false`. Exit 0.
- `bun run biome check` on changed TS/JS/JSON/MD source files (37 files, excluding generated `packages/database/migrations/meta/0047_snapshot.json`). Exit 0. No fixes applied on the final tree.

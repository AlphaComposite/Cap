# cap-fzp.8.7.1 / 8.7.4 race workstream

Branch `wire/race` from `a715811ed0`. Local commits only. Not pushed. Production containers, `/srv/styrir/apps/cap`, `/etc`, other worktrees, and the `capwire-e2e` / `capsec` stacks were not touched. No browser measurement.

## Commits

- `32ba726197` fix: join a same-intent prepare instead of returning 409
- `e37aebfaa7` fix: drop a late settle prepare after Done starts
- `6165c78c04` fix: wait for an in-flight seg0 prefetch instead of loading it again

## What changed

R1. `publishInstantFinishRevision` joins a same-session `COMMITTED_INTENT`/`PREPARING` row whose intent matches, without holding the publication lock across origin I/O. It polls to `READY` and flips through `reuseVerifiedReady` (MAC still verified). A failed or different-intent in-flight prepare is not a 409: a different intent is superseded, a failed prepare is replaced by a new attempt. A different session, or a base generation that is not the current generation and not the adjacent same-session preclick, still 409s.

R2. `postRevisionRoute` takes an `AbortSignal`. The settle prepare keeps its controller on a ref. `handleDone` bumps a monotonic request id and aborts that controller with the timer clear, so a late prepare response cannot write `generation`. The prepare route observes `request.signal` and marks the revision `FAILED` only while it is still `COMMITTED_INTENT`/`PREPARING` and not marked `publish-joined`.

R3. `instant-finish-fragment-cache.ts` keeps an inflight map keyed like the cache (`pathname`+`search`). `prefetchInstantFinishPlaylist` registers that promise before the fragment body arrives. The HLS loader waits for it on a miss instead of calling the base loader. A load that starts before `rememberPrefetchedFragment` also waits. Consume-once and bounding were left for the security builder; the prefetched map itself is unchanged aside from delivery to waiters.

R4. In `allocateRevision`, a stale `expectedEditSpec` is rejected before the current-intent no-op, except a same-session retry whose `draftVersion` is not older than the recorded draft. A second tab with a stale expected spec and the same current spec gets 409 and its draft is not advanced. The existing same-session late prepare of the just-published spec still returns the current revision.

`revision-publication.ts` was limited to `allocateRevision`, `publishInstantFinishRevision`, `allocateInputAfterPreclick`, `reuseVerifiedReady`, and the join poll those need. Readback, outbox, thumbnail status, relocation, the route guard, and origin side artifacts were not edited.

## Tests

Disposable MySQL `caprace-mysql` on `127.0.0.1:36116`, database `caprace`, removed with `docker compose -p caprace-mysql -f /srv/styrir/scratch/cap-fzp-8-wire/caprace-mysql/compose.yml down -v`.

Passing on this branch:

- joins an in-flight prepare of the same spec, one origin prepare, current revision is that row
- supersedes an in-flight prepare of a different spec
- a failed prepare does not block a new attempt
- different session and non-adjacent `baseGeneration` still 409
- second tab with a stale `expectedEditSpec` 409s and does not advance the draft
- existing same-session late prepare of the just-published spec still returns the current revision
- seg0 load before `rememberPrefetchedFragment` does not call the base loader
- HLS loader waits for a prefetch registered at fetch start
- settle fence rejects a response after Done; `postRevisionRoute` forwards the signal
- prepare route returns 499 on abort when unjoined, and 200 when a publish has joined

Failing-before was not re-run on `a715811ed0` in this session. Scout-k already measured that publish during an in-flight prepare 409s at the generation check, and that a seg0 load before remember hits the network.

## Gates

- `cd apps/web && bunx vitest run revision- save-video-edits video-edit instant-finish fix2 revision-publish-route seg0-inflight revision-settle-prepare revision-prepare-abort` with `CAP_WIRE_A_DATABASE_URL` pointed at the disposable MySQL. 24 files, 213 tests, 0 failed. Includes `revision-publication.integration.test.ts` (15 passed, not skipped).
- `bun run biome check --write` on the changed TS/TSX files. Clean.
- `cd apps/web && bunx next typegen`. Exit 0. No generated-file diff.
- `bunx tsc -b apps/web --pretty false --incremental false` with `NODE_OPTIONS=--max-old-space-size=6144`. Exit 0. The default Node heap aborted; that was an out-of-memory crash, not a type error.

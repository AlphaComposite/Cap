# WORKSTREAM-FIX11

Base: wire/integration c129cc2965
Worktree: /srv/styrir/worktrees/cap-fzp-8-wire-integration
Builder: FIX11 (grok-4.7)
Bead: cap-fzp.8.7.17
Scope: failUnjoinedInflightPrepare lock order only. No retry. No push. capwire-e2e, build-e2e, and production were not touched.

## Fix

apps/web/lib/revision-prepare-abort.ts. The FAILED update now runs inside db().transaction that first does select id from videos where id=? for update, then the existing update and predicates. publish-joined and originPrepareIsRunning checks are unchanged and still run before that transaction. If only revisionId is given, a plain select resolves videoId and that video is locked.

Research-19 (findings.md, session 20260927_115946_6a39db) recommended a bounded whole-transaction retry on ER_LOCK_DEADLOCK and a consistent videos-first lock order. Parent dispatch for this path is lock order only: a retry would hide the inversion. Same parent-first order as fix6/fix8. No retry added.

## Test

apps/web/__tests__/unit/revision-publication.integration.test.ts "does not deadlock failUnjoinedInflightPrepare against allocateRevision". Two connections. allocateRevision holds videos (paused in the existing inventory probe, which runs after the videos FOR UPDATE and before the join update). failUnjoinedInflightPrepare runs on the same video. One side is in LOCK WAIT, then the hold is released. Both must fulfill, and a rejection must not be ER_LOCK_DEADLOCK.

Failing-before on c129cc2965, product file unchanged: expected true to be false at the deadlock check. Evidence /srv/styrir/scratch/cap-fzp-8-wire/evidence-fix11/deadlock-before.txt.

Passing-after: that test passed in 358ms, including the lock-wait observation. Evidence deadlock-after.txt.

## Gates

Disposable MySQL capf11-mysql, bind 127.0.0.1:33171 only. Password was in a chmod 600 env file, not on the command line. Container and env file removed. docker ps -a --filter name=capf11 was empty afterwards.

Gated vitest with CAP_WIRE_A_DATABASE_URL: 38 files, 276 passed (baseline 275 plus this test). EXIT 0. Integration file was not skipped.

NODE_OPTIONS=--max-old-space-size=6144 ./node_modules/.bin/tsc -b apps/web: EXIT 0.

biome check on the two touched files: clean.

## Noticed, not fixed

The 40-done / WebKit census in the bead acceptance is still the parent's capwire-e2e run. Not run here.

The joined and origin-running checks stay outside the lock transaction, as specified. A publish-joined write that lands between the check and the update is still excluded by the existing SQL predicate.

# vk-24 checkpoint

Attempt vk-24.1, base c38f6f1a0d, branch feature/vk24-durable-hls, only this worktree. Candidate not committed yet. No production/provider/DB/Docker/service/deploy/push/delete operations. vk-23 resources and retained evidence untouched.

Design settled before implementation in DESIGN.md. Existing download helper/outbox/private edited prefix reused; distinct web-revision-artifact service audience; no source gate or encoder/namespace changes and no origin SQL view. HLS receipts are optional metadata inside the existing JSON download receipt, not DDL.

Implemented so far: sequential bounded HLS collection with exact per-object version/SHA/full readback; same namespace validation; caption/chapter/thumbnail snapshot checks; existing current/live-lease completion extended with side-snapshot fence; HLS backfill through existing retry budget. Signed internal web exact-artifact route pins and hashes complete bytes, rechecks receipt/current/epochs. Origin public HLS/side/Range reads can use it with an empty cache, no source construction or FFmpeg. No MP4 player change.

Fail-first evidence: red-artifact.log shows 1 new behavioral failure, 25 existing passes. red-origin-behavior.log shows empty-cache/Range/identity/post-fetch failures against baseline serving logic; initial red-origin.log was a harness grant-id error (401), not valid RED evidence. Current green: 26 artifact tests and 6 cold-origin tests pass, including real loopback signed HTTP and actual subprocess transport, with original/encoder functions forbidden. Fixtures are synthetic exact bytes, not decoded media or B2 evidence.

Next: finish cold internal callers and snapshot normalization, add endpoint/integrity/partial-map/lease-focused cases, scoped format and regressions, commit clean candidate then rerun focused diagnostics. Parent owns restricted disposable-MySQL proof of new metadata predicates and backfill, real B2/application/browser/media/renewal/restoration evidence and independent review. No approved Verk receipt or full vk-22 completion is claimed. No eviction or deletion eligibility exists.

# vk-24 exact revision HLS

Baseline c38f6f1a0d. Scope is durable HLS, not eviction, deployment, source-read expansion or full vk-22 acceptance.

## Traced convergence points

Next rewrites `/media/*` to origin. `OriginApp._media` verifies the existing grant, publication/current generation and epochs, dispatches all playlist/init/segment/side requests, then rechecks before returning. Range segment reads currently reconstruct Origin too. `_artifact`, `_range_segment` and `_internal_artifact` all depend on local ranges, namespace, original/mezz and audio state. Merely keeping their output files or the durable MP4 is insufficient.

The internal artifact endpoint supplies token-free playlist bytes, init, numbered segments and signed captions/chapters/thumbnail. Its callers are publication prepare/readback/reuse, source-prepare caption readiness, caption refresh and thumbnail registration. Public URLs are built by revision-media-grant; players retain HLS and renew grants. Playlist token substitution is the existing `playlist_with_grant`, not a new playlist format. `lib_origin.Origin` chooses persisted v3/v2/historical-four-thread identities; this code remains unchanged.

The existing download outbox already builds every segment in the background and has bounded rounds, a transfer deadline and atomic post-await current/source/owner/generation/lease fencing. Its durable helper streams uploads, requires VersionId and independently reads/hash-checks the full pinned version. Generic storage/object denies every non-internal private/edited key before GET/HEAD/Range/redirect. Reuse all of these.

## Minimal extension

Extend the existing download receipt with an optional exact HLS artifact map. After finalized download availability, sequentially fetch the token-free playlist and exactly its numbered segments, init and all three side artifacts through the installed signed origin client. Reuse persistRevisionDownload for each bounded artifact via its stream seam, retaining the same private/edited prefix and full pinned readback. Require one namespace across the map; no encoder or namespace changes. Keep one artifact in memory at a time with a hard per-artifact ceiling and a segment-count ceiling. Missing/corrupt artifacts fail the existing bounded job; never advertise partial HLS completeness. Keep completed objects/versions even on stale work.

Attach the map only through the existing completion transaction and live lease/current fences. Capture caption/chapter/thumbnail metadata at transfer start, fence that snapshot at completion, and reject durable reads when current side metadata differs. Legacy durable MP4 receipts remain usable for downloads; backfill HLS through the same job/cycle budget.

Origin cold playback asks a distinct service-MAC audience on a narrow web internal endpoint for an exact revision artifact, never a caller-supplied storage descriptor. Web selects the trusted current receipt, pins VersionId, validates full size/SHA and rechecks current receipt/epochs after IO. Origin validates returned identity/namespace/length/SHA and uses the existing grant insertion and Range handling. No original/source fetch, Origin construction or FFmpeg is needed on this path. The endpoint derives from the existing origin-to-web endpoint setting; no new service or credential. Errors fail closed; only a definitive missing HLS receipt may use the existing warm generation path. Source gates remain byte-for-byte unchanged.

No origin SQL/view change is needed: web already has the receipt and current publication. Existing worker completion SQL uses actual edit_revision, video_publication, videos, outbox and revision_artifact_status; new metadata predicates require later disposable restricted-MySQL proof by the parent.

## Re-edit gap and non-goals

Existing prepareSourceOnEditorOpen -> signed source prepare restores the registered private source and verifies SHA before source identity. However warmSourceFromRow can skip preparation based on DB warm expiry although an isolated local volume is empty; regenerated mezz/audio/encoder identity also does not prove old namespace byte identity. This phase does not change editor admission or promise restoration proof. Exact HLS bypasses this dependency for viewing only. No cache removal, eligibility, B2 deletion or indefinite cache-removal guarantee is implemented.

## Evidence boundary

Focused fail-first tests must exercise real candidate imports, exact fixture bytes, empty origin cache with source/encoder functions forbidden, namespace/side/receipt integrity, stale current/lease completion, bounded retry behavior and the existing private-prefix bypass denial. Provider transport evidence from vk-23 establishes only the installed helper's observed transport, not this complete application path. Parent owns real B2/runtime/browser/SQL/review gates; local committed diagnostics are not an approved Verk receipt.

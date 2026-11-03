# Durable revision downloads (stage 1)

The existing download outbox now exports the finalized edited MP4 through the authenticated origin download GET, uploads it under an attempt-unique private key, and reads the entire returned object version back before recording readiness. Playback and Done still use their existing publication/HLS path. This does not make the editing workspace disposable.

## Identity and verification

`edit_revision.metadataSnapshot.downloadArtifact` holds the verified owner, video, revision, generation, source ID, full origin namespace, bucket, key, VersionId, SHA-256, and byte length. This is an additive TypeScript shape on an existing JSON column, not a SQL schema change; no migration is required.

Small files use PUT; larger files use sequential 8 MiB multipart parts. Transfer hashing covers the uploaded bytes. An independent full GET pinned to the returned VersionId must return that version, HTTP 200, the exact length, and the same independently computed SHA-256. ETags are used only as opaque multipart completion tokens, never as content digests. Failed verification cannot create a receipt or durable READY.

Every attempt has a new key. Completed object versions are never deleted, including failed verification, superseded attempts, lost leases and crash retries. Incomplete multipart uploads are aborted best-effort; this is not object-version deletion. Origin files are not removed or rewritten by this path.

Transfer time is bounded to ten minutes, within a twelve-minute job lease. Multipart part memory is bounded to 8 MiB plus transport buffers; files above 10,000 such parts are rejected. Request cancellation also cancels upstream transfer/readback. These bounds need measurement against real large exports before rollout.

Completion locks the publication, revision, owner, artifact and outbox rows before its final statement, avoiding MySQL's statement-start clock being frozen before a lock wait. The final atomic update checks the current revision/generation, source/owner identity, lease token and database-clock lease expiry before saving the receipt and READY together. A stale upload remains stored but cannot change the current pointer or receipt. No publication rollback is performed on export failure.

One in-process promise guards the existing outbox drain. The public sweep detaches that drain so the publication-readback tick is not held by a slow B2 transfer; there is no additional queue or service. Source preparation remains on the existing worker path.

## Compatibility and retries

A legacy local-only READY is still locally downloadable while durability is missing. It is now eligible for backfill rather than being skipped. `downloadDurabilityStarted` resets legacy export retry counters once; subsequent durable failures retain the existing bounded retries/cooldown. A verified receipt stops this backfill. The legacy download flag alone never asserts remote durability.

## Protected delivery

The shared download descriptor selects `/api/video/edited-download` only for a trusted verified current receipt. Otherwise it preserves the existing edited-origin download URL, not an unedited-original fallback.

Each GET, HEAD and Range request requires a download-specific CAP grant, a logged-in user, the existing view/download permissions, and matching current publication/policy epochs. The current receipt and permissions are checked again after the storage await. Client-provided object keys and versions are ignored. Playback grants cannot be used for downloads.

The route streams the pinned version through CAP, returns private/no-store responses and sanitized attachment names, and never redirects to a reusable storage URL. Range parsing preserves the origin's single explicit-start byte range semantics, including 416 for suffix/multiple/invalid ranges. A ranged GET must receive the exact upstream 206, Content-Range and length; an ignored range or incorrect version fails closed rather than being relabelled 206. HEAD supports the same range headers without reading an object body.

## Required integration proof before rollout

The focused tests exercise the real TypeScript upload/delivery code and HttpApi handler with storage/auth/SQL doubles, plus Python's signed origin streaming handler with local fixtures. They do not prove B2 compatibility, effective provider privacy, database grants or row-lock behavior in a real MySQL server.

The installed SDK's offline request-handler probe emits `aws-chunked` with an `x-amz-checksum-crc32` trailer for streaming PUT. Whether B2 accepts that exact runtime serialization is unproved and is a rollout blocker; no provider configuration was changed to hide it.

The parent must run a bounded disposable restricted-user MySQL proof for the exact generated SELECT/UPDATE statements, including lease expiry during a lock wait and supersession while upload is pending. It must also prove real B2 PUT/multipart completion and pinned-version full readback, an actual edited MP4's decode/duration/content, authenticated GET/HEAD/Range and revocation, and Done plus immediate HLS while B2 is stalled or unavailable. Web, origin and the separate revision worker need coordinated reviewed release artifacts; this change is not deployed.

Local eviction, durable HLS, cold playback/restoration, source relocation's existing deletion policy, IAM/provider configuration and lifecycle changes are outside stage 1. Existing source-key admission/signing gates remain unchanged.

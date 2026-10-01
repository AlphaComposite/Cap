# AlphaComposite fork release notes

These notes describe the maintained `downstream/main` fork, not an official
CapSoftware release. Runtime configuration and credentials stay outside Git.

## Deployment parity follow-up

- Persist the tested `ORIGIN_MAX_KEEP_RANGES=1024` in the fork Compose default,
  configurable through the existing environment setting. This admits the real
  long-recording combined-cut plans that exceeded the native default of 512.
  Direct native launches still need the explicit setting; native code is unchanged.
- Version the exact Example production host-worker launcher and systemd unit under
  [`deploy/example/`](deploy/example/README.md). They are site-specific examples,
  contain no credential values, and use external credential files and the existing
  revision worker. Review the documented paths before using them elsewhere.
- The external-worker startup guard and its regression tests were already in
  `d0708cd9c0` before the live web switch. No post-switch application hot patch is
  introduced by this follow-up. Resolved production Compose overrides, credential
  files, acceptance sessions and recordings remain outside Git.
- Fast first-open remains an acceptance requirement: initialize historical
  recordings and verify a fresh long upload before its first editor request.
  Successful editing on an already-prepared source does not satisfy that gate.

## Revision-based web editing — owner-accepted release candidate

### Changes

- Publish edited playback before returning from Done; build the downloadable MP4
  asynchronously from that revision's media.
- Preserve independent manual, pause and filler cut layers, transcript selection
  deletion/restoration, Undo/Redo, and removed sections in the editor.
- Bind frame selection to the actual prepared source. Preserve the accepted
  rendered ranges through reopening, unchanged Done and metadata saves instead
  of reconstructing intervals containing no source frames.
- Restore original through a local editor reset followed by Done; retain the
  original source and use retained editions when appropriate.
- Keep captions and the share transcript on the published edition's clock.
- Preserve canonical source chapters across cuts and restores. Chapters shorter
  than ten output seconds are hidden by projection (a sole chapter is allowed).
  Owner chapter edits remain validated on the edited clock.
- Keep owner-pasted summary editing above Chapters; preserve summary text through
  publication and restoration. No automatic summary generation is introduced.
- Provide revision downloads on share and dashboard, including HEAD and
  case-insensitive Range handling. Pending downloads produce a neutral retry
  message.
- Prepare newly ready flagged uploads and an uncut baseline through durable
  server work, with protected-source staging and publication fences.
- Preserve eligible unedited legacy playback while the opt-in revision path is
  not yet applicable; do not expose an edited video's private original to viewers.

### Verification scope

The owner accepted the viewing build in Chrome. The selected integration gate
passed 529 web tests in 77 files and TypeScript checks; the retained native gate
ran 102 tests with one skipped. Recorded browser evidence covers
combined removal, Done, playback, reopening, metadata saves and restoration.
This is evidence for the accepted build, not a universal latency guarantee,
Safari certification, an audio-listening result, or proof of every future upload.
Production deployment and post-deployment evidence are separate operational gates.

### Deployment prerequisites

1. Back up the database, object data and environment-specific Compose/routing
   configuration. Record rollback images and an exact source revision; preserve
   existing auth, encryption, provider, storage and summary/chapter settings.
2. Build the downstream web application with the deployment's own public URLs.
   Do not deploy bundles built for a viewing hostname. Remove traced environment
   files in the builder and scan exported image layers for known secret values.
3. Apply the generated additive revision migration
   `packages/database/migrations/0047_brown_spitfire.sql` through the application's
   migration mechanism before serving the revision path.
4. Deploy `apps/instant-finish-origin` with persistent cache, resource limits,
   service authentication, grant signing keys and a restricted object-store
   identity. Scope storage reads to registered source keys and required revision
   objects; do not rotate a shared storage credential to revoke one video's URL.
5. Provision `origin_video` as an operator-managed SECURITY DEFINER view and an
   origin database identity with only the needed SELECT/column privileges. The
   example `apps/instant-finish-origin/sql/origin-readonly.sql` is a disposable
   template: **never apply its placeholder password in production**. Include its
   staged `source_relocation` column privileges.
6. Route `/media/` to the revision origin, suppress token-bearing access logs and
   prevent shared caching. Verify GET, HEAD, Range and expired/revoked grants
   through the existing public route; a cache-management API permission error
   alone does not establish a need to change domains or edge rules.
   Configure both the web and origin service secrets consistently and select
   limits that admit the deployment's real edit documents.
7. Configure `CAP_INSTANT_FINISH_OWNERS` and the revision-origin environment for
   explicitly selected owners. Place durable preparation/readback/download work
   in the deployment's supported server workflow. Set
   `CAP_REVISION_WORKER_MODE=external` on the web service when running
   `startRevisionReadbackWorker` with policy reconciliation in a privileged host
   worker; leave it unset to retain the existing in-process behavior. Do not mount
   the Docker socket or add storage-admin variables to the public web runtime.
   Verify the required SQL objects and scoped storage access before enabling
   the owner flag.
8. Re-publish existing edited recordings from their saved source-time intent,
   without re-editing, with a pilot and per-item source/summary/chapter checks.
   Unchanged editor Done is navigation-only and is **not** a backfill command.
   Coordinate activation and backfill to avoid unavailable existing recordings.
9. Verify public share, embed and downloads, owner edit/save/reopen/restore,
   metadata preservation and rollback on the exact running images.

Turning a feature flag off is not, by itself, a safe rollback after public source
objects have been relocated. Use the saved object journal and verified rollback
copies; do not fall back to exposing stale rendered or private original bytes.

### Known limits and follow-ups

- Chrome is the accepted browser; Safari/WebKit was excluded from this release.
- Real editor/share audio waveform work and inline removed-item pills are not
  included. Existing waveform visuals must not be treated as measured audio peaks.
- Broader long-playback/late-access renewal investigation is parked; an observed
  pause is not evidence that renewal was its cause.
- Translated transcript alignment, video-only/no-audio upload coverage and
  relocated comment attachments require separate acceptance.
- Additional thumbnail-retry/resource housekeeping and the app-wide cookie-auth
  CSRF audit are separate follow-ups; this does not waive publication-route guards.
- Desktop releases and upstream synchronization are not part of this web release.

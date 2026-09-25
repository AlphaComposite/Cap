# W-C revision player

Branch `wire/c-player` in `/srv/styrir/worktrees/cap-fzp-8-wire-c-player`, base `a17a3348fa`. Local commit only. No push, no Beads, no production containers, no live MySQL/MinIO, no `/etc/nginx`.

## What landed

Flagged owner videos skip `getSharePlaybackUrl` / `result.mp4` prefetch, omit `initialPlaybackUrl`, and mount `HLSVideoPlayer` (not `CapVideoPlayer`) on share and embed, including webMP4/desktopMP4. Player URL is `/media/{videoId}/r/{revisionId}/playlist.m3u8?t=<grant>`. Relative init/seg/VTT/thumbnail URLs also take `t`. Flag off stays on the existing MP4/raw-preview path.

One seek helper (`apps/web/lib/revision-seek.ts`) pauses before seek, calls hls.js `startLoad(target)` only when the target is outside `buffered`, and re-seeks to mid-span when the first rVFC `mediaTime` is at or past `frameStart + span + 20ms`. Scrubber pauses once on drag start and corrects on commit. Transcript/chapter/comment/time-query, timeline store, keyboard/seek buttons, embed start time, and player.js `setCurrentTime` all call it. Safari native HLS has no Hls instance: pause/rVFC still run, and a media `error` refreshes the grant instead of swapping in an MP4.

Direct `raw-preview` and `segments-*` go through D's `decidePlaylistPresign`. A flagged owner, or `CAP_INSTANT_FINISH_PLAYLIST_DENY`, returns 404/410 before `video_edits` or raw object probes. Flagged clients do not request raw-preview. Flagged MP4 playlist signing is also denied.

Done stays labeled Done. It calls A's `publishRevision` with the V2 spec, baseline spec, generation, draftVersion, and draft session. 200 navigates to share. 409 keeps the draft and asks for retry. Flag-off falls through to `saveVideoEdits`. The stub never returns a fake revision. No post-Done Processing overlay is set for a revision playback object.

Revision comments use A's output-time map (missing or null timestamps are hidden). Chapters and captions come from the revision DTO / captions URL, not the videoId-global transcript. Summary is left on the video row. Download shows Preparing until `downloadReady`. OG/Twitter stream type is `application/vnd.apple.mpegurl` for the current revision path. That crawler URL does not embed the 60s bearer. The player URL does. Bearer values are not logged; `redactMediaGrant` exists for later HAR dumps.

## Files

Owned edits:
- `apps/web/app/s/[videoId]/page.tsx`
- `apps/web/app/s/[videoId]/Share.tsx`
- `apps/web/app/s/[videoId]/_components/ShareVideo.tsx`
- `apps/web/app/s/[videoId]/_components/HLSVideoPlayer.tsx`
- `apps/web/app/s/[videoId]/_components/playback/playback-store.ts`
- `apps/web/app/s/[videoId]/_components/video/media-player.tsx`
- `apps/web/app/s/[videoId]/edit/EditVideoClient.tsx`
- `apps/web/app/embed/[videoId]/page.tsx`
- `apps/web/app/embed/[videoId]/_components/EmbedVideo.tsx`
- `apps/web/app/embed/[videoId]/_components/use-player-js-receiver.ts`
- `apps/web/app/api/playlist/route.ts` (raw-preview/segments denial and flagged mp4 denial only)
- `apps/web/lib/share-video-metadata.ts`
- `apps/web/__tests__/unit/segment-playlist-route.test.ts`
- `apps/web/__tests__/unit/revision-player.test.ts`

C-owned helpers:
- `apps/web/lib/revision-playback.ts`
- `apps/web/lib/revision-playback-load.ts`
- `apps/web/lib/revision-seek.ts`
- `apps/web/lib/revision-done.ts`

## Contract stubs (integrator replaces)

- `apps/web/lib/instant-finish-flag.ts` — CONTRACT STUB (owned by W-A). Env `CAP_INSTANT_FINISH_OWNER_IDS`.
- `apps/web/lib/revision-publication.ts` — CONTRACT STUB (owned by W-A). Returns enabled plus empty current revision. No summary field.
- `apps/web/actions/videos/publish-revision.ts` — CONTRACT STUB (owned by W-A). Flag-off returns `{reason:"flag-off"}`. Flag-on returns 503, never a fake `{success:true}`.
- `apps/web/lib/revision-media-token.ts` — CONTRACT STUB (owned by W-D). Claims type and 60s TTL only. No signer.
- `apps/web/lib/revision-media-grant.ts` — CONTRACT STUB (owned by W-D). `mintRevisionMediaGrant` returns null. `decidePlaylistPresign` denies flagged raw/segments/mp4, or honors `CAP_INSTANT_FINISH_PLAYLIST_DENY=not-found|gone`.
- `apps/web/app/api/media/grant/route.ts` — CONTRACT STUB (owned by W-D). POST returns 501 `grant-unavailable`, `private, no-store`. Does not log the body.

## Commands and exits

Install used Bun because this tree has `bun.lock` and no `pnpm-lock.yaml`.

- `systemd-run --user --unit capwire-c-player-install ... bun install` — exit 0. Memory peak 824.1M.
- `bun run biome check` on the owned TS/TSX files except `media-player.tsx` — exit 0. `media-player.tsx` still reports pre-existing unused-var / `noImgElement` / non-null warnings outside this diff; those were not introduced here.
- `systemd-run --user --unit capwire-c-player-unit3 ... bun run --cwd apps/web test __tests__/unit/revision-player.test.ts __tests__/unit/segment-playlist-route.test.ts __tests__/unit/share-video-metadata.test.ts` — exit 0. Test Files 3 passed. Tests 48 passed. Duration 3.09s.
- `systemd-run --user --unit capwire-c-player-typegen ... bun run --cwd apps/web next typegen` — exit 0.
- `systemd-run --user --unit capwire-c-player-tscb5 ... NODE_OPTIONS=--max-old-space-size=4096 bun run tsc -b --pretty false` — exit 0. Earlier `tsc -b` without the heap flag aborted (V8 heap limit, SIGABRT). Earlier `tsc -p apps/web` without built package dists was not a valid check.

Playlist denial covered by the route tests: flagged owner, no `video_edits`, no `editProcessing`, raw-preview 404 and no sign/head; segments-master 404; mp4 404; `CAP_INSTANT_FINISH_PLAYLIST_DENY=gone` returns 410 `private, no-store`. Unedited flag-off raw-preview still 302.

## Not run

No isolated compose, nginx, Chromium, or Safari/WebKit run. No HAR, no screenshots, no oracle frame IDs, no stall timing. Do not treat the unit tests as the section 9 gate. Integrator still needs >=20 cold/READY, first NEW frame p95<=1.5s, duration +5/+30, 242 joins/729 IDs, A/V <=1 frame, realtime p95<=0.5x, privacy/fence on the six real sources.

Until A and D replace the stubs, a flagged page renders unavailable (mint returns null) and Done shows the 503 error instead of navigating. That is intentional. Grant refresh on 403/410/5xx calls `/api/media/grant` and reloads the same revision only when the body revisionId matches and a grant is returned; 410 or a changed revisionId calls `router.refresh()`.

## Integration notes

- Replace the six stubs in place. Do not rename them.
- A publication DTO consumed here: `{enabled,currentRevisionId,generation,duration,revisionMetadata:{duration,chapters,captionsAvailable,commentTimestamps,thumbnailAvailable,downloadReady},draftVersion,draftSession}`. Summary is not part of the DTO.
- Publish input: `{videoId,ownerId,editSpec,expectedEditSpec,baseGeneration,draftVersion,draftSession}`. Success is only `{success:true,revisionId,generation}`.
- D grant refresh body expected by the player: `{revisionId,grant}` for the same revision, or `{changed:true}` / 410 to drop the old src and SSR the new pointer.
- Crawler metadata uses the grantless current playlist path and HLS MIME. Do not put the 60s bearer in OG/Twitter tags.
- B must serve tokenized relative children from that playlist. C does not rewrite segment URLs itself.
- Mobile route remains D-owned. This player does not call it.
- `CapVideoPlayer` raw fallback is unchanged for unflagged unedited webMP4.

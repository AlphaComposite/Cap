# Per-site lint exceptions

CI's Biome lint command is enforcing, not advisory. The exceptions below are
adjacent, rule-specific suppressions, not rule/configuration disables. They cover
the original 33 findings in 24 source files: 14 stable IDs, eight positional keys, three
interaction wrappers, five missing-caption previews and three natural/imperative
images. A zero-diagnostic lint result does not establish accessibility compliance.

## Stable identities — `lint/correctness/useUniqueElementIds` (14)

Next Script uses its ID as a loaded-script cache key. Each retained literal is
canonical to one route and schema kind: different routes must not collide, while
repeat mounts must deduplicate. Do not replace these with random/per-instance IDs,
remove the IDs or hide them behind constants. Script payloads, JSON escaping,
content type and loading strategy remain unchanged. This does not promise removal
of earlier routes' scripts from the document.

| Source                                                             | Sites                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `apps/web/app/(site)/(seo)/solutions/agencies/page.tsx`            | Agencies FAQ and software (2)                                                        |
| `apps/web/components/blog/RecordScreenMacStructuredData.tsx`       | Blog article and FAQ (2); retained security-tested component                         |
| `apps/web/components/pages/seo/DailyStandupSoftwarePage.tsx`       | Daily-standup FAQ (1)                                                                |
| `apps/web/components/pages/seo/EmployeeOnboardingPlatformPage.tsx` | Onboarding FAQ (1)                                                                   |
| `apps/web/components/pages/seo/LoomAlternativePage.tsx`            | Loom-alternative FAQ (1)                                                             |
| `apps/web/components/pages/seo/OnlineClassroomToolsPage.tsx`       | Classroom FAQ (1)                                                                    |
| `apps/web/components/pages/seo/RemoteTeamCollaborationPage.tsx`    | Remote-team FAQ (1)                                                                  |
| `apps/web/components/pages/seo/ScreenRecordMacPage.tsx`            | Mac-recorder FAQ (1)                                                                 |
| `apps/web/components/pages/seo/ScreenRecordWindowsPage.tsx`        | Windows-recorder FAQ and software-app (2)                                            |
| `apps/web/components/pages/seo/ScreenRecordingSoftwarePage.tsx`    | Recording-software FAQ (1)                                                           |
| `apps/web/app/(site)/self-hosting/SelfHostingPage.tsx`             | Single public `#features` target (1); incoming fragment links require this stable ID |

The Mac support transition additionally introduces one public `#intel-mac` archive
anchor in the download versions page. Its adjacent, explicit
`useUniqueElementIds` exception preserves inbound unsupported-Intel redirects;
the literal is not hidden behind a constant. This new site is separate from the
original 33-finding baseline above.

## Positional identity — `lint/suspicious/noArrayIndexKey` (8)

These are positions, not mutable entities. Do not manufacture IDs or key by
nonunique letters/words/text. Introduce real source IDs if these become editable,
stateful or reorderable entity collections.

| Source                                                                                                  | Sites and invariant                                                                               |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/web/app/(org)/dashboard/settings/organization/components/CustomDomainDialog/SubscribeContent.tsx` | Fixed domain character animation positions (1)                                                    |
| `apps/web/app/(site)/oss-friends/loading.tsx`                                                           | Nine fixed loading slots (1)                                                                      |
| `apps/web/app/s/[videoId]/_components/timeline/TimelineRail.tsx`                                        | Filmstrip slots survive asynchronous URL replacement without remounting slots (1)                 |
| `apps/web/components/mdx.tsx`                                                                           | Primitive text headers, rows and cells; no interactive row/cell state, duplicate text allowed (3) |
| `apps/web/components/ui/TextReveal.tsx`                                                                 | Static copy's word-position animation ranges, including repeated words (1)                        |
| `packages/ui/src/components/SkeletonRows.tsx`                                                           | Fifteen fixed placeholder positions (1)                                                           |

## Interaction enhancements — `lint/a11y/noStaticElementInteractions` (3)

These exceptions depend on real keyboard alternatives; a dialog merely existing
elsewhere is insufficient. Reverify the actual source path and authorization
when move entry points, folder destinations or permission gates change. Do not
add a pretend interactive role to the wrappers.

| Source                                                                   | Sites and keyboard prerequisite                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/app/s/[videoId]/_components/CommentStamp.tsx`                  | Outer hover boundary (1). The named native button receives focus, reveals the tooltip and seeks the same timestamp on Enter and Space. Outer hover ownership keeps the tooltip open during pointer traversal into it.                                               |
| `apps/web/app/(org)/dashboard/folder/[id]/components/BreadcrumbItem.tsx` | Current-folder and ancestor drop wrappers (2). Actual `FolderVideosSection` → `CapCard` → More options → Move → `MoveItemsDialog` uses keyboard navigation and destination buttons to emit the same video ID, folder ID and resolved location as a breadcrumb drop. |

Personal folder routes pass the creator/context management gate; space and
organization folder routes pass the matching collection management gate. The
card requires `canMove`, a location and a root label for both dragging and the
Move entry. Video ownership alone does not grant space/organization management:
a permitted manager may move a nonowned shared item, but a nonmanager owner
cannot. Personal moves remain restricted to owned videos on the server. Both
paths converge on `moveVideos`; the drag adapter resolves personal, organization
or space location first. No authorization gate is widened by these exceptions.
The current destination is disabled in the dialog because it is already there;
dropping an already-present item is not an additional relocation capability.

Focused offline Chromium checks exercise actual source components and installed
React/Radix controls, including Tab/arrow navigation and Enter/Space activation,
with server-action/context boundaries isolated. They are component proof, not
production navigation, database authorization or screen-reader certification.

## Natural/imperative images — `lint/performance/noImgElement` (3)

| Source                                                                 | Site and lifecycle                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/web/app/(site)/changelog/_components/ChangelogView.tsx`          | Unknown-size Markdown image retains natural sizing, alt text and lazy loading (1)   |
| `apps/web/app/s/[videoId]/_components/timeline/TimelineHoverGhost.tsx` | Thumbnail controller owns `imgRef.src` imperatively (1)                             |
| `apps/web/components/tools/MediaFormatConverter.tsx`                   | Converted Blob GIF retains natural aspect ratio within its preview height limit (1) |

Do not invent intrinsic dimensions or replace imperative image ownership simply
to silence a performance rule. Revisit when real metadata or lifecycle work
provides a verified equivalent.

## Deferred accessibility limitation — `lint/a11y/useMediaCaption` (5)

These are real missing accessibility capabilities, not false positives or claims
of compliance. Native controls and user-selected media do not supply equivalent
accessible content. No empty tracks, fake captions, muting or preview removal
stand in for the missing feature.

| Source                                               | Deferred sites                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/web/components/tools/MediaFormatConverter.tsx` | Converted video caption import/playback and converted audio transcript display (2) |
| `apps/web/components/tools/SpeedController.tsx`      | Speed-adjusted output caption import and retiming (1)                              |
| `apps/web/components/tools/TrimmingTool.tsx`         | Source caption import and trimmed output caption clipping/rebasing (2)             |

Follow-up feature scope: accept meaningful local VTT with language/label controls,
make video captions selectable, provide an accessible audio transcript display,
transform cue timing for speed changes, and clip/rebase cues for trimming. Keep
caption/transcript data and object URLs aligned with source/output replacement
and unmount. Tests should cover real cue display/selection, malformed VTT errors,
keyboard access, speed timing, trim boundaries, replacing files and URL cleanup.
Remove each exception only after its actual capability and regression tests exist.

## Verification boundary

Retain the original failed audits rather than rewriting history. Existing
`lint-batch-a`, `lint-batch-b`, `seo-residuals`, `runtime-residuals`, edit-readiness
and media-store ref regressions remain required scoped guards. In particular,
actual Next loader A→B and A→A cases and hostile JSON/script payload assertions
must continue to pass. Whole tracked-source Biome must report zero errors,
warnings and unprinted diagnostics, including no unused-suppression warnings.
Integration typecheck, combined tests and final CI remain integration gates.

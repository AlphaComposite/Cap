# WORKSTREAM-FIX8

Base: wire/integration e9a44c3e17
HEAD after the six item commits: f4aeb565ad
Worktree: /srv/styrir/worktrees/cap-fzp-8-wire-integration
Builder: FIX8 (grok-4.7)
Rule: fix only what each item names. One local commit per item. No push. No production.

## Status

- [x] 8.7.21 D1 flipCurrent lockVideoRow
- [x] 8.7.22 D2 readback exhaustion revert
- [x] 8.7.25 D8 handled finally chains
- [x] 8.7.23 D3/B2 inventory fence
- [x] 8.7.24 D6 bounded copy/hash
- [x] 8.7.27 D10 policy off the request path
- [x] failing-before gate
- [x] gated web vitest + typecheck
- [x] capwire-e2e scored + 11-row (cap8w-scout-r inactive before the rebuild)
- [x] disposable containers removed

Scored fixture/webkit missed the +150 ms gate. 11-row z9/webkit row 4 missed. Those are recorded below, not waived.

## Notes

Inputs read: PLAN-sol-delta.md; scout-q Q1 Q2 Q3 Q4 Q8; research-21 Q1 Q3; research-22 Q1 Q4; research-23 Q1 Q2 Q5; research-24 Q1 Q2 Q4; review D1 D2 D3 D6 D8 D10.

cap8w-scout-r was inactive before the web rebuild. Origin files were not changed, so origin was not rebuilt for the code change. Row 11 of the copied e2e script recreated origin and restored the default 2 CPU quota. Origin was healthy afterwards.

Web rebuild: `next build --turbopack` from apps/web with build-e2e/web.env. Compiled in 58s. BUILD_ID tm-rZCtyvuL9IDhmA81MO. Web container recreated. Probe before scored cells: web S3 range GET 206, origin playlist 200, EXTM3U 1. No credential values printed.

## 8.7.21 D1

Commit: 3eb90ecfa8 fix: lock videos first in flipCurrent

Product: apps/web/lib/revision-publication.ts flipCurrent. First statement is lockVideoRow before video_publication FOR UPDATE. Probe after that lock so the sibling test can hold. flipCurrent exported for the test.

Test: revision-publication.integration.test.ts "does not deadlock flipCurrent against allocateRevision".

Failing-before (lockVideoRow removed): expected true to be false at the deadlock check.

After: deadlock pair passed.

## 8.7.22 D2

Commit: 4939eb025c fix: revert current when readback attempts are exhausted

Product: claimDueReadback no longer deletes the outbox row inside the claim transaction at the attempts ceiling. It commits the lease, then in a separate step calls revertCurrentAfterReadback with reason "readback attempts exhausted" and deletes only if that lease token still matches. A fenced publication still deletes the row. Alert kept.

Test: "reverts current when readback attempts are exhausted".

Failing-before: expected 'wireaexhcurr001' to be 'wireaexhprev001'. Row deleted, current unchanged.

After: passed, including the fenced variant.

## 8.7.25 D8

Commit: 5140639e0a fix: handle readback and fragment rejection chains

Product: startRevisionReadbackWorker uses `void run.then(clear, clear)` instead of `void run.finally(...)`. instant-finish-fragment-cache.ts chains `.catch(() => undefined)` after the inflight finally. No process-wide handler.

Tests: readback sweep reject and inflight prefetch reject emit no unhandledRejection.

Failing-before (old void finally restored): both failed. Sweep received Error: db. Prefetch received Error: prefetch.

After: both passed.

## 8.7.23 D3

Commit: 657c5c5755 fix: fence Finish on a complete source inventory

Product:
- openInstantFinishEditor always calls relocateFlaggedSource. The alreadyPurged short-circuit is gone.
- source-relocation inventory includes screenshot.jpg.
- readReadySource, after assertFinishSourceKey, refuses with the existing 409 source error unless every source_relocation row is PURGED and the prefix list has no key outside private/source/ and private/rollback/. finishInventoryProbe.listPrefix is the test seam. No relocation on the share/playback request.

Tests: integration "relocates on editor open after purge and refuses Finish while a public key remains". Inventory assertion includes screenshot.jpg.

Failing-before: inventory did not contain screenshot.jpg. Combined base checkout could not collect the integration file because finishInventoryProbe is new.

After: integration file 24 passed on the disposable MySQL.

Runtime proof on capwire-e2e, owner e2eflagowner001:
- Before this proof the prefixes e2eflagowner001/e2efixture00001/ and e2eflagowner001/z9x58adx1ra8bm3/ were already empty (count 0). Prior editor opens had purged them. source_object rows were PURGED.
- Planted, immediately before this editor open, three exposed names per video: raw-upload.mp4, screenshot.jpg, segments/audio/segment_000.m4s. Presigned GET URLs used the in-network minio host.
- Before open: GET 200, HEAD 403 (GET signature used as HEAD), Range 206, all six keys.
- Editor open HTTP 200 for both videos.
- After open: GET 404, HEAD 403, Range 404, all six keys. All >= 400. Prefix counts returned to 0.

## 8.7.24 D6

Commit: 53d60a7266 fix: copy and hash relocations without buffering

Product: apps/web/scripts/instant-finish-relocate.ts createS3Store. sha256 updates createHash from GetObject body chunks and never calls transformToByteArray. copy uses HeadObject then CopyObject (URL-encoded CopySource) at or under 5 GiB, else CreateMultipartUpload + UploadPartCopy (5 MiB parts unless that would exceed 10000) + CompleteMultipartUpload, AbortMultipartUpload on error. Journal and verify steps unchanged.

Test: instant-finish-relocate-store.test.ts. Failing-before: expected hash, received null. After: passed. 5 GiB + 1 byte used 1025 UploadPartCopy ranges and no GetObject.

Runtime proof on disposable MinIO, fresh process, real createS3Store:
- seeded 1610612736 and 5905580032 byte zero objects
- sha256(old)==sha256(new) for both
- process VmHWM 143372 KiB (140 MiB). systemd Memory peak 106.5M. Bound is 300 MiB. Before was 3.12 GiB for 1.5 GiB.
- synthetic objects deleted

## 8.7.27 D10

Commit: f4aeb565ad fix: publish origin read policy off the editor path

Product:
- refreshOriginReadPolicy call removed from openInstantFinishEditor.
- readback worker tick calls reconcileOriginReadPolicy. It publishes only when the sorted live-key set hash differs from the last successful publish.
- publishOriginObjectPolicy no longer rm-then-creates. One admin policy create. Disposable MinIO probe: a second create on the same name exited 0 and updated the document, so the versioned-name fallback was not required. policy rm is not issued before attach.
- Missing root credentials log an error and do not set the published hash.

Tests: openInstantFinishEditor with MINIO_ROOT_USER set does not spawn. A failing create does not rm before attach.

Failing-before: spawn expected false, received true. rm-before-attach expected true, received false.

After: both passed.

Runtime proof, policy capf8-origin-read, scoped user:
- before the changed publish: old key GET 200, new key 403, unlisted key 403
- during publish, 24 samples at 50 ms on the listed old key, statuses [200], deniedDuringChange 0
- after: old 200, new 200, unlisted 403
- read-back resources: arn:aws:s3:::capf8/private/source/new and arn:aws:s3:::capf8/private/source/old, updated 2026-09-27T15:53:06.745Z
- synthetic objects deleted

## Gates

Failing-before, product files checked out to e9a44c3e17, new tests kept, then restored: EXIT 1. 6 failed tests, 41 skipped.
- unhandledRejection prefetch: expected [] received [Error: prefetch]
- unhandledRejection sweep: expected [] received [Error: db]
- sha256: expected hash, received null
- inventory: screenshot.jpg missing
- editor spawn: expected false, received true
- policy rm before attach: expected true, received false
- integration suite did not collect on the base tree (finishInventoryProbe undefined). D1 and D2 assertion failures were recorded on their own failing-before runs.

Gated vitest (fix6 unit glob plus the new store/policy tests plus the integration file): 35 files, 266 passed, VITEST 0. Includes the DB integration tests.

`NODE_OPTIONS=--max-old-space-size=6144 ./node_modules/.bin/tsc -b apps/web`: TSC 0.

A full apps/web vitest, which is not the 237-test baseline, reported 35 failed and 3590 passed. Those failures are outside the gated glob (server-only import errors and unrelated 500s). They were not treated as this fix's regression set.

Origin unittest was not rerun. No origin file changed in the six commits.

## Scored

measure4.mjs immediate, n=20, one browser at a time, load under 2 before each cell. p95 is the 2nd slowest. Baseline p95: 1246, 1149, 1241, 1796.

fixture/chromium: raw 1256, 1069, 1122, 1075, 795, 1065, 1047, 1068, 1224, 1078, 1198, 1162, 1063, 1255, 1041, 1176, 1356, 1118, 1107, 1208. p50 1107, p95 1256, max 1356, publishMs p95 534. origin starts 20, completes 20, terminated 0. delta +10. pass.

z9/chromium: raw 856, 921, 901, 876, 924, 829, 937, 1141, 862, 851, 821, 885, 779, 913, 940, 856, 849, 844, 912, 835. p50 862, p95 940, max 1141, publishMs p95 447. origin starts 29, completes 20, terminated 9. delta -209. pass.

z9/webkit: raw 1106, 1068, 1093, 1023, 1134, 1186, 1184, 1043, 1049, 1055, 1530, 1175, 1309, 1136, 1214, 1041, 1113, 932, 995, 975. p50 1093, p95 1309, max 1530, publishMs p95 512. origin starts 28, completes 21, terminated 7. delta +68. pass.

fixture/webkit: raw 2502, 1644, 1788, 1478, 1280, 2199, 1556, 1156, 1449, 1472, 1116, 1700, 1538, 1522, 1780, 1777, 1966, 1625, 1680, 1171. p50 1556, p95 2199, max 2502, publishMs p95 591. origin starts 20, completes 20, terminated 0. delta +403. FAIL. The +150 ms gate is missed. The slowest run's publishMs was 170 and seg0ToPainted was 940, so the miss is not a Finish-path tax.

80/80 newRevision. actionStatus 200 on all 80. Chromium p95 1256 and 940, both under 1500.

## 11-row

Chromium fixture and z9: rows 1-7 pass, row 8 alias checks 302 without a presign, row 9 left the editor, rows 10-11 pass.

WebKit fixture: rows 1-7 pass. z9/webkit row 4 fail: early seek stallMs 15023 (limit 2000), currentTime equalled duration 2.141666. Other z9/webkit rows passed. Rows 8-11 are not engine-split beyond the recorded files; row 8/9/10/11 passed.

Not 11/11 both engines. fix7 z9/webkit row 4 passed (early stall 63 ms).

## Deadlock / 500

Web container logs: Deadlock 0. Lines containing ' 500 ': 0. nginx access.log status 500: 0 across 140150 lines.

## Disposable containers

Removed: capf8-mysql, capf8-minio, volume capf8-minio-data. `docker ps -a --filter name=capf8` was empty afterwards.

capwire-e2e left running. z9 keep end reset to 12. Origin healthy, NanoCpus 2000000000.

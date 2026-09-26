# cap-fzp.8.7.10 — unmount the editor at Done

Branch `wire/unmount` from `wire/race` `811a28a1b5`. Not pushed. Production containers, `/srv/styrir/apps/cap`, `/etc`, other worktrees, and the running `capwire-e2e` / `capsec-*` stacks were not touched.

## Commits

- `5e22beb448` `fix: unmount the editor shell while publish is in flight`
  - `apps/web/app/s/[videoId]/edit/EditVideoClient.tsx`
  - `apps/web/__tests__/unit/editor-publish-unmount.test.ts`

`handleDone` snapshots history, draft, and playhead, then sets saving before the publish await. The editor shell early-returns a `Saving / Publishing` placeholder (`data-editor-shell="publishing"`). Timeline, transcript, trim handles, and the preview video unmount. The share video is not rendered. `router.push` still waits for publish to return. A 409, publish error, or abort restores that snapshot, shows the existing toast, and re-enables Done. No `content-visibility`, extra `startTransition`, `useOptimistic`, Next preview flags, or server actions.

## Tests

Failing before, on `811a28a1b5`, fixture editor, WebKit, immediate Done, n=5: nodes at `history.pushState` were 2793 and `actionToNav` p95 was 1008 ms. Gate is nodes <= 400 and `actionToNav` p95 <= 800 ms.

Passing after, on `5e22beb448`, same cell: nodes 85, `actionToNav` p95 606 ms.

Unit (`bun run test` on the touched area, jsdom `createRoot`): `renders the publishing placeholder and unmounts the timeline before publish resolves`; `restores cuts, selection, and draft after 409|500|abort`. Placeholder asserts no video, no trim handles, no transcript, and no `router.push` before the publish promise settles. Related gate: `Test Files 23 passed | 1 skipped (24)`. `bunx next typegen` exit 0. `NODE_OPTIONS=--max-old-space-size=6144 bun run tsc -b apps/web` exit 0. Biome clean on the two changed files.

Browser failure restore, after build, route interception held 800 ms, fixture `e2efixture00001`:

- WebKit 409, Chromium 409, WebKit 500, Chromium 500: placeholder text `Saving / Publishing`, 0 videos, 0 trim handles, still on `/edit`. After the response: editor shell back, 689 trim handles (same as before the click), Done enabled, localStorage draft unchanged. 409 toast `A newer draft exists. Retry Done.` 500 toast `forced failure`.

Abort is covered by the unit case, not by a browser interception.

## Measurement

Disposable compose project `capunm`, loopback web `127.0.0.1:37120`, copied harness `capunm/measure.mjs` (original `build-e2e/measure.mjs` not edited). Immediate mode, n=5 per cell, fixture and z9, Chromium and WebKit. Before artifact is the `811a28a1b5` build. After artifact is `5e22beb448`. p50/p95 are nearest-rank (`ceil(p/100*n)-1` on the finite values). For n=5, p95 is the maximum finite value. 409 count is the number of Done actions whose recorded status was 409. seg0 GET is the count per Done.

Host at the before run (`22:00:09`): `load average: 5.50, 5.95, 5.47`.
Host at the after run (`22:06:03`): `load average: 9.87, 8.58, 6.76`.

Before, `811a28a1b5`. Every cell: new revision 5/5, status 200, 409 count 0, seg0 GET 1.

| cell | painted p50/p95 | actionToNav p50/p95 | clickToAction p50/p95 | seg0ToPainted p50/p95 | nodes |
| --- | --- | --- | --- | --- | --- |
| fixture/chromium | 1525 / 2261 | 571 / 778 | 641 / 1260 | 178 / 245 | 2793 |
| fixture/webkit | 2442 / 3183 | 882 / 1008 | 520 / 1260 | 591 / 855 | 2793 |
| z9/chromium | 1614 / 2069 | 589 / 617 | 810 / 1026 | 118 / 128 | 288 |
| z9/webkit | 2468 / 2696 | 819 / 945 | 1021 / 1143 | 239 / 340 | 288 |

Raw before painted: fixture/chromium `[2261, 1575, 1495, 1525, 1496]`; fixture/webkit `[2334, 2480, 3183, 2442, 1885]`; z9/chromium `[2069, 1465, 1964, 1558, 1614]`; z9/webkit `[2157, 2392, 2696, 2468, 2493]`.
Raw before actionToNav: fixture/chromium `[778, 589, 511, 571, 504]`; fixture/webkit `[687, 932, 1008, 882, 744]`; z9/chromium `[617, 589, 505, 514, 596]`; z9/webkit `[612, 777, 945, 819, 859]`.
Raw before clickToAction: fixture/chromium `[1260, 650, 641, 601, 609]`; fixture/webkit `[520, 1212, 1260, 429, 336]`; z9/chromium `[936, 634, 1026, 810, 622]`; z9/webkit `[899, 910, 1021, 1066, 1143]`.
Raw before seg0ToPainted: fixture/chromium `[59, 179, 151, 178, 245]`; fixture/webkit `[784, 90, 591, 855, 322]`; z9/chromium `[118, 89, 128, 104, 120]`; z9/webkit `[170, 166, 340, 239, 258]`.
Raw before nodes: fixture both browsers `[2793, 2793, 2793, 2793, 2793]`; z9/chromium `[288, 288, 281, 288, 288]`; z9/webkit `[288, 288, 288, 288, 281]`.

After, `5e22beb448`. 409 count 0 in every cell. seg0 GET 1 on every navigated Done.

| cell | painted p50/p95 | actionToNav p50/p95 | clickToAction p50/p95 | seg0ToPainted p50/p95 | nodes |
| --- | --- | --- | --- | --- | --- |
| fixture/chromium | 1239 / 1315 | 387 / 464 | 443 / 525 | 68 / 165 | 85 |
| fixture/webkit | 2385 / 2611 | 516 / 606 | 1142 / 1710 | 322 / 468 | 85 |
| z9/chromium | 1393 / 1774 | 420 / 444 | 716 / 817 | 103 / 134 | 85 |
| z9/webkit | 1739 / 1895 | 431 / 470 | 701 / 802 | 197 / 373 | 85 |

Raw after painted: fixture/chromium `[1269, 1225, 1315, 1174, 1239]`; fixture/webkit `[1931, 2472, 2611, 2385, 1589]`; z9/chromium `[1258, 1709, 1774, 1393, 1295]`; z9/webkit `[1895, null, 1745, 1696, 1739]`.
Raw after actionToNav: fixture/chromium `[414, 464, 387, 371, 335]`; fixture/webkit `[544, 606, 461, 516, 481]`; z9/chromium `[399, 427, 420, 444, 372]`; z9/webkit `[470, null, 431, 448, 349]`.
Raw after clickToAction: fixture/chromium `[512, 443, 525, 438, 435]`; fixture/webkit `[1258, 1142, 1710, 1012, 259]`; z9/chromium `[630, 817, 777, 716, 670]`; z9/webkit `[802, null, 788, 701, 666]`.
Raw after seg0ToPainted: fixture/chromium `[56, 165, 68, 77, 58]`; fixture/webkit `[null, 422, 176, 322, 468]`; z9/chromium `[103, 103, 134, 84, 107]`; z9/webkit `[373, null, 299, 163, 197]`.
Raw after nodes: 85 on every navigated trial. z9/webkit run 2 is null.

z9/webkit after run 2 did not navigate: `page.waitForURL` timed out at 90s, frame wait timed out at 15s, publish POST count 1, prepare POST count 2, seg0 GET 0, no new revision, recorded action status null. Not a 409. The other 19 after trials published a new revision.

## Risks

- The after host was busier (load 9.87 vs 5.50). Fixture WebKit `clickToAction` p95 rose 1260 to 1710 ms, so the painted drop (3183 to 2611) is not a clean quiet-host comparison. `actionToNav` and nodes still fell on the busier host.
- One z9 WebKit after trial timed out. Not reproduced in the other after trials. Left as a miss, not retried into the table.
- Navigation still starts only after publish returns. The overlap hold for bead 8.7.11 is unchanged.
- Restoring the editor remounts the heavy tree. That is the failure path only.

`docker compose -p capunm --profile web down -v` removed `capunm-web-1`, `capunm-nginx-1`, `capunm-origin-1`, `capunm-minio-1`, `capunm-minio-setup-1`, `capunm-mysql-1`, and volumes `capunm_mysql`, `capunm_minio`, `capunm_cache`. Evidence remains under `/srv/styrir/scratch/cap-fzp-8-wire/capunm/evidence-before` and `evidence-after`.

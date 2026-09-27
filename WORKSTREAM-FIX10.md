# WORKSTREAM-FIX10

Builder: grok-4.7. Bead: cap-fzp.8.7.23 old-key purge fence. Base: f9a8ae6163. Branch: wire/integration. No push. No production. No container rebuild.

## Change

Nested lookalikes were exempt from relocation and Finish because transcript checks used endsWith/regex on any key, and both inventory and Finish skipped any key that merely contained `private/source/` or `private/rollback/`.

- `isRetainedTranscriptKey(key, prefix)` matches only `${prefix}transcription.vtt`, `${prefix}transcription.<2-letter lang>.vtt`, `${prefix}transcription.edit.v3.json`, and `${prefix}transcription.edit.v3.status.json`.
- `comments/` exemption unchanged: `${prefix}comments/`.
- Finish no longer skips keys containing `private/source/` or `private/rollback/`. `readReadySource` calls `assertFinishInventoryClear`, which 409s unless every listed key is `isFinishInventoryExempt`. Missing list still 409s.
- `inventoryExposedKeys` private skip is `key.startsWith("private/")`, after the owner/video prefix check. No substring match.

## Failing-before (f9a8ae6163)

Product files unchanged. New assertions in `source-relocation-gate.test.ts`. Vitest EXIT 1, 3 failed, 4 passed, 21:24:00.

- inventory did not contain `owner/vid/segments/transcription.vtt`
- Finish predicate (the then-current includes + suffix exempt) refused none of the 4 lookalikes (`[]` vs the 4 keys)
- relocate left nested lookalikes in place (`expected true to be false`)

## Gates

`cd apps/web && ../../node_modules/.bin/vitest run` on the gated globs: 37 files passed, 1 skipped, 249 passed, 26 skipped. EXIT 0. The integration file skipped because `CAP_WIRE_A_DATABASE_URL` is unset. Parent reruns it with DB. That file now lists the 4 exact transcript keys plus `comments/c1/media.mp4` as a passing Finish inventory, and the 4 nested lookalikes as a 409 refusal, before the existing `result.mp4` refusal.

`NODE_OPTIONS=--max-old-space-size=6144 ./node_modules/.bin/tsc -b apps/web`: EXIT 0.

Biome check --write on the 4 touched files: clean.

## Noticed, not fixed

- Comment media is still inventoried and relocated on editor open. Finish exemption only. Pre-existing; this brief said keep `${prefix}comments/` and not change the rest of inventory.
- `extraKeys` still tags a key as original when it contains `/source/`. A nested `private/source` lookalike is tagged original and still relocated.
- `get-available-translations.ts` still suffix-matches `transcription.vtt`. Its list prefix is `${owner}/${video}/transcription`, so it is not this fence.
- `startsWith("private/")` is unreachable after the owner/video prefix check unless `ownerId` is `private`. UserId is an unconstrained string. Prescribed semantics.

# Origin timeout regression

Run from the repository root with Bun 1.4.0 and installed dependencies:

```sh
cd apps/web
/root/.bun/bin/bun --no-env-file scripts/check-origin-timeout.ts
/root/.bun/bin/bun --no-env-file scripts/check-origin-timeout.ts --long
```

The standalone check imports the application's public source-prepare and HTTP
origin client functions. It uses only a synthetic signing secret and an ephemeral
127.0.0.1 HTTP fixture, not production origin, storage or database responses.

The long mode delays response headers for 310 seconds: old Bun transport fails
near 300 seconds; the fix must finish successfully. Routine mode uses 25 ms.
Both modes verify method/path/body signing, source-key identity, caller abort,
already-aborted callers and malformed identity rejection. A process-local seam
asserts the requested deadline is 45 minutes, then shortens only that signal to
40 ms to exercise header and response-body cancellation, including with a live
caller signal. No application timeout setting is overridden in long mode.

Bound execution with `systemd-run --user --wait --pipe -p MemoryMax=4G
-p RuntimeMaxSec=370`, an absolute `--working-directory` and explicit HOME/PATH.
Run final proof on a committed, clean candidate; keep the old failure separately.

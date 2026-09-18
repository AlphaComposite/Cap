# Downstream maintenance

This fork keeps upstream Cap history separate from downstream product changes.

## Branches

- `main` is a clean, fast-forward-only mirror of `CapSoftware/Cap:main`.
- `downstream/main` contains the maintained downstream changes and is the default branch.
- `sync/upstream-<sha>` branches are temporary review branches created when upstream changes are available.

Do not commit downstream changes directly to `main`. Do not rewrite published downstream history after deployment. Merge upstream into `downstream/main`; do not repeatedly rebase the long-lived branch.

## Remotes

A maintenance checkout should use:

```text
origin    https://github.com/AlphaComposite/Cap.git
upstream  https://github.com/CapSoftware/Cap.git
```

Verify them before syncing:

```bash
git remote -v
git fetch --prune origin
git fetch --prune upstream main
```

## Automated proposal

`.github/workflows/propose-upstream-sync.yml` runs weekly and can also be dispatched manually from GitHub Actions. It:

1. Fetches `CapSoftware/Cap:main`.
2. Fast-forwards the fork's clean `main` mirror.
3. Exits when `downstream/main` already contains that upstream revision.
4. Otherwise merges upstream into `sync/upstream-<sha>` and opens a pull request against `downstream/main`.
5. Stops on conflicts. It never auto-merges into `downstream/main`.

A conflict failure is a request for a maintainer to create the sync branch locally, resolve each conflict, run the verification gates, and push the reviewed result.

## Manual upstream sync

Start from a clean full clone:

```bash
git fetch --prune origin
git fetch --prune upstream main
git switch --create sync/upstream-$(git rev-parse --short upstream/main) origin/downstream/main
git merge --no-ff upstream/main
```

If conflicts occur, preserve both the upstream intent and the downstream invariants. For reversible media editing, pay particular attention to:

- immutable original-source handling;
- independent manual, no-speech, and filler layers;
- edit-document schema parsing and migration;
- draft/save optimistic concurrency;
- preview/render/download range equivalence;
- signed playback URL handling;
- global audio splice transitions and multi-batch rendering.

After resolving conflicts, review the complete upstream delta—not only conflict markers:

```bash
git diff --check origin/downstream/main...HEAD
git log --oneline --left-right origin/downstream/main...upstream/main
```

Then run the repository's pinned toolchain and the relevant focused, full, type, and static checks. Media-renderer changes require real FFmpeg output plus FFprobe inspection; UI/editor changes require authenticated browser acceptance after deployment.

Push the sync branch and open a pull request into `downstream/main`. Merge only after required checks and review pass.

## Deployment boundary

Repository history contains source code only. Keep these outside the public fork:

- production domains and routing;
- provider credentials and secret-bearing environment files;
- local Compose image overrides;
- account-specific deployment templates;
- generated runtime data and backups.

Build immutable images from an exact `downstream/main` revision, record their digests, and deploy using environment-specific configuration outside Git. Verify the running image IDs and force a fresh capability-level runtime test after each deployment.

## Upstream contribution

When a downstream change is generally useful, create a focused branch from clean `main`, cherry-pick or reimplement only that change, and open a pull request to `CapSoftware/Cap`. Do not submit deployment configuration, private operational details, or the entire downstream branch upstream.

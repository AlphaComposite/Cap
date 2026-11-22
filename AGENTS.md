# Agent instructions

Checks are the source of truth. Style lives in `biome.json` and `Cargo.toml` `[workspace.lints]`, not in prose here.

Setup: [CONTRIBUTING.md](CONTRIBUTING.md). Default branch: `downstream/main`.
Do not start extra `bun run dev*` or Docker services; assume they are already running.

Package notes: [apps/web/AGENTS.md](apps/web/AGENTS.md), [emails/AGENTS.md](emails/AGENTS.md).

## Commands

Prefer scoped checks on touched files. Full-repo gates below match CI.

| Check | Local | CI |
| --- | --- | --- |
| Lint (Biome) | `bun run lint` (`biome lint`) | advisory (`biome ci .` is allowed to fail) |
| Format (Biome) | `bun run format` (`biome check --write`) | `biome ci . --linter-enabled=false` |
| Format (Rust) | `cargo fmt --all` | `cargo fmt --check` |
| Typecheck | `bun run typecheck` | same |
| Tests | `bun run test` | subset in Typecheck, Mobile, and path workflows |
| Clippy | `cargo clippy --workspace --all-features --locked -- -D warnings` | same, when Rust paths change (macOS/Windows) |
| Public hygiene | `bash scripts/check-public-hygiene.sh` | same |
| Emails | `bun run emails:check` | same, plus email script tests |
| Tauri plugins | `bun run check-tauri-versions` | when plugin files change |

`bun run typecheck` is `bun run --cwd apps/web next typegen && bun run tsc -b`.

Scoped:

```sh
bun run biome check --write <files>
cargo fmt --all && cargo check -p <crate>
bun run test:web
bun run --cwd apps/mobile test
cargo test -p <crate>
```

## Pre-commit

Enable the repo hook once:

```sh
git config core.hooksPath .githooks
```

`.githooks/pre-commit` format-checks staged JS/TS/JSON/CSS with Biome, runs `cargo fmt --check` when `.rs` files are staged, and runs `scripts/check-public-hygiene.sh`.

## CI workflows

Every PR and every push to `main` or `downstream/main`: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — hygiene, typecheck, mobile, Biome format, rustfmt, Clippy (Rust paths), desktop build (desktop paths), Tauri plugin versions.

Path-triggered: `validate-migration-journal.yml`, `recording-reliability.yml`, `sync-tests.yml`, `database-profile-reliability.yml`, `windows-targets.yml`, `test-self-hosting.yml`, `docker-build-media-server.yml`.

Manual or scheduled (do not run unless asked): `desktop-release.yml`, `publish.yml`, `publish-nightly.yml`, `promote-nightly.yml`, `publish-chrome-extension.yml`, `docker-build-web.yml`, `performance-regressions.yml`, `loops-safety.yml`, `propose-upstream-sync.yml`, `opencode.yml`.

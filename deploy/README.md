# Generic self-hosted deployment

Use Python 3 with PyYAML 6 and Docker Compose v2.26 or later. No application runtime dependencies are added.

## Configuration

From the checkout root:

```sh
cp deploy/config.example.yaml deploy/config.yaml
```

Edit the YAML for your own domains, image references, ports, resource limits and host paths. Every key is required, including the external worker settings (unused unless you install that worker). Relative paths resolve from the YAML file's directory. Keep the real YAML outside Git; `deploy/config.yaml`, `.env.deploy`, the generated override and `deploy/*.env` are ignored.

Secrets never go in YAML. Provision the referenced `paths.compose_env_file`, `paths.web_env_file` and `paths.origin_env_file` separately with mode 0600. The Compose interpolation file holds the existing database, storage, auth and provider credentials. Runtime files hold the web/revision flags and origin service/grant keys; follow `deploy/origin-prepare.md` and the origin SQL templates for the restricted origin identity. Do not use the Compose development credential defaults in production. The web `DATABASE_URL` uses the interpolated `MYSQL_PASSWORD`; runtime `env_file` does not override an explicit Compose environment key. Supply those explicit keys through the Compose interpolation file.

Build or pull images for your own public URLs before rendering. The web/origin services retain `pull_policy: never`; the renderer does not build or pull images. Configure DNS/TLS and routing separately; substitute your hostnames in `deploy/nginx/`. Mount storage/workflow data persistently, provision the workflow directory with the web image's required ownership, and provision the origin cache for UID 65532 before enabling revision playback.

```sh
python3 deploy/render-config.py --self-check
python3 deploy/render-config.py deploy/config.yaml
docker compose --env-file deploy/compose.env --env-file .env.deploy \
  -f docker-compose.yml -f docker-compose.override.yml config -q
docker compose --env-file deploy/compose.env --env-file .env.deploy \
  -f docker-compose.yml -f docker-compose.override.yml up -d
```

Replace `deploy/compose.env` above with `paths.compose_env_file`. The order matters: generated non-secret settings override existing interpolation settings. Always pass `.env.deploy` explicitly; Compose does not load that filename automatically. The renderer writes deterministic, atomic, mode-0600 outputs beside `paths.compose_file`; `--compose-file CHECKOUT/docker-compose.yml` selects a different checkout without editing the YAML. Rendered images, runtime env files and the workflow bind mount are supplied by the override. It never reads credential files or starts containers. Avoid printing unredacted `docker compose config`, which resolves credentials.

## Privileged revision worker

`revision-worker/launch.py CONFIG.yaml` is the generic lift of the existing host launcher. It privately reads the configured containers and the `worker.env_file`, resolves the database address on `worker.network`, and starts the application's existing readback worker with policy reconciliation. That credential file uses literal, unquoted `KEY=VALUE` lines without shell expansion. Set `CAP_REVISION_WORKER_MODE=external` in the web runtime before starting it; startup refuses to compete with an in-process worker.

Run `python3 deploy/revision-worker/launch.py --self-check` to exercise environment wiring and the competing-worker guard with mocked Docker/exec, without starting a worker.

Prepare the checkout dependencies and the parent of `worker.temp_dir`. Substitute `@CHECKOUT@`, `@CONFIG@`, `@USER@` and `@GROUP@` in `revision-worker/cap-revision-worker.service.in` before installing the unit. The account needs Docker inspection access and private credential-file access; the default template limits it to 4 GiB and 200% CPU. Do not mount Docker or worker credentials into the public web container. Worker installation/restart is a separate operator action, not performed by the renderer.

Verify required SQL objects, scoped storage policy, historical source backfill and preparation of a fresh upload before its first editor request. A warm-cache editing test alone is insufficient.

## Public hygiene and optional fixtures

CI runs `bash scripts/check-public-hygiene.sh` against tracked files. Run it before committing; private configuration, image pins and working notes must stay outside the public checkout. It rejects site-specific host paths and Chromium identity IDs, but allows the generic identity protocol suffix.

`CAP_TEST_FIXTURE_DIR` opts into the existing disposable integration fixtures. When unset, fixture-backed web/origin cases and the origin smoke runner skip rather than reading a host-specific path. Place `parent-test.env` in that directory for the three MySQL integration suites; the existing local-host and disposable-database fences remain unchanged. The lock-order suite writes its three evidence logs there. Origin oracle tests read `keep-ranges.json`, `frame-table.json` and `mezz.frames.json` there. The smoke Compose mounts its `player/` directory and the runner writes generated media under `smoke/`; Compose requires the variable to be set. Never point these tests at a production database.

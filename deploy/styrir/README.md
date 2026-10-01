# Styrir host revision-worker example

These two files are exact copies of the launcher and systemd unit used for the
`d0708cd9c0` production release. They contain no credential values. This is a
site-specific, tested deployment recipe, not a portable automatic installer.

## Assumptions

- The accepted release is unpacked at `/srv/styrir/releases/cap/d0708cd9c0/src`
  with its prepared dependencies. Bun is at `/root/.bun/bin/bun`.
- Docker containers are `cap-web`, `cap-mysql` and `cap-minio` on the
  `cap_cap-network` network; the database URL uses the `mysql` hostname.
- The private MinIO and origin endpoints are localhost ports 9010 and 3020.
  The existing public web URL is `https://cap.styrir.com`.
- Origin credentials are in `/srv/styrir/shared/env/cap-origin.env`, owned by
  root with mode 0600. Never commit this file or resolved container environments.
- The launcher is installed at `/srv/styrir/shared/bin/cap-revision-worker.py`.
  The service is installed as `cap-revision-worker.service`.
- The public web service has `CAP_REVISION_WORKER_MODE=external` and the intended
  `CAP_INSTANT_FINISH_OWNERS` value. Do not run a competing in-process consumer.

The launcher reads existing container settings and the external origin secret
file privately, obtains storage-admin settings only for the host process, and
runs the existing source preparation/readback/download worker with off-request
policy reconciliation. It does not add a Docker socket or new storage-admin
variables to the public web container. `--conditions=react-server` is required.
The systemd unit bounds memory to 4 GiB and uses a root-only umask.

For a later release or another host, review the release path, working directory,
container/network names, endpoints, Bun path and private temporary directory
before installation. Update the launcher and unit together. Do not copy the
server's resolved Compose file or credential files into the repository.

Before enabling external mode, verify worker startup, required SQL objects,
scoped storage reads and policy reconciliation. Read back the actual running
image IDs and keep-range limit. The fork Compose default is 1024 keep ranges;
the native direct-launch default remains 512 unless explicitly configured.

Upload-ready hooks do not retroactively initialize historical recordings.
Verify historical backfill and source readiness before the first editor request,
and separately test a fresh long upload. A warm-cache editing test is not proof
that first-open preparation ran in the background.

#!/bin/sh
# Provision the origin's read-only MinIO user. Not for the production root user.
# Usage: MINIO_ROOT_USER=... MINIO_ROOT_PASSWORD=... ORIGIN_S3_ACCESS_KEY=... ORIGIN_S3_SECRET_KEY=... \
#   ./deploy/minio/setup-instant-finish-origin.sh http://127.0.0.1:9000
set -eu
endpoint="${1:?minio endpoint}"
root_user="${MINIO_ROOT_USER:?}"
root_password="${MINIO_ROOT_PASSWORD:?}"
access_key="${ORIGIN_S3_ACCESS_KEY:?}"
secret_key="${ORIGIN_S3_SECRET_KEY:?}"
alias_name="${MINIO_ALIAS:-capfixorigin}"
policy_name="${ORIGIN_S3_POLICY:-instant-finish-origin-read}"
case "$alias_name" in
  *[!A-Za-z0-9_]*) echo "MINIO_ALIAS must be an MC_HOST identifier" >&2; exit 2 ;;
esac
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
policy_file="$here/instant-finish-origin-policy.json"
endpoint_host="${endpoint#http://}"
endpoint_host="${endpoint_host#https://}"
if ! command -v mc >/dev/null 2>&1; then
  policy_file=/policy/instant-finish-origin-policy.json
  mc() {
    docker run --rm --network host --entrypoint mc \
      -e "MC_HOST_${alias_name}=http://${root_user}:${root_password}@${endpoint_host}" \
      -v "$here:/policy:ro" \
      minio/mc:RELEASE.2025-08-13T08-35-41Z "$@"
  }
fi
mc mb "$alias_name/cap" --ignore-existing
mc mb "$alias_name/other" --ignore-existing || true
mc admin policy create "$alias_name" "$policy_name" "$policy_file" \
  || mc admin policy info "$alias_name" "$policy_name" >/dev/null
mc admin user add "$alias_name" "$access_key" "$secret_key" || true
mc admin policy attach "$alias_name" "$policy_name" --user "$access_key"
echo "origin minio user ready"

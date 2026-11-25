#!/usr/bin/env bash
# Isolated stack only. Mount the parent directory read-only into each web
# workflow executor. Leave the startup tuple unset and point the server's
# CAP_TRANSCRIPT_SPEAKER_LABELS_CANARY_FILE at the mounted final filename.
# Take the cutoff before Start (date +%s%3N), then wait for the next second
# before clicking Start (the DB stores createdAt to whole seconds). Bind the
# server-issued IDs after Start and before Stop. Never remove or rewrite the
# binding while the isolated stack runs; use a fresh private directory per run.
set -euo pipefail
export LC_ALL=C

if [[ $# != 4 || $1 != /* || ! $2 =~ ^[0-9a-z]{15}$ || ! $3 =~ ^[0-9a-z]{15}$ || ! $4 =~ ^[0-9]{13}$ ]]; then
	printf '%s\n' 'Usage: bash bind-speaker-label-canary.sh /absolute/file ownerId videoId cutoffEpochMs' >&2
	exit 2
fi
now=$(date +%s%3N)
if (( 10#$4 > now || 10#$4 < now - 3600000 )); then
	printf '%s\n' 'Selector cutoff must be within the past hour' >&2
	exit 2
fi

umask 077
tmp=$(mktemp -- "$(dirname -- "$1")/.selection.XXXXXXXX")
trap 'unlink -- "$tmp"' EXIT
printf '%s/%s/%s' "$2" "$3" "$4" > "$tmp"
chmod 0444 -- "$tmp"
# Publish the complete file atomically, without ever replacing the first bind.
ln -T -- "$tmp" "$1"

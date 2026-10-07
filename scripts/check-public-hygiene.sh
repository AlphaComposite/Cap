#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
set +e
git grep -lE '/srv/|[a-p]{32}\.chromiumapp\.org' -- . ':!scripts/check-public-hygiene.sh'
status=$?
set -e
if (( status == 0 )); then
	printf '%s\n' 'Public hygiene failed: deployment-specific content in tracked files.' >&2
	exit 1
fi
if (( status != 1 )); then
	exit "$status"
fi
printf '%s\n' 'Public hygiene passed.'

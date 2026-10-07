#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
set +e
# Generic checks here; deployment names come from PUBLIC_HYGIENE_EXTRA_PATTERN
# (CI secret / local hook, matched case-insensitively) so this public file
# never names a deployment.
{
	git grep -lE '/srv/|[a-p]{32}\.chromiumapp\.org' -- . ':!scripts/check-public-hygiene.sh'
	if [[ -n ${PUBLIC_HYGIENE_EXTRA_PATTERN:-} ]]; then
		git grep -ilE "$PUBLIC_HYGIENE_EXTRA_PATTERN" -- .
	fi
} | sort -u | grep .
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

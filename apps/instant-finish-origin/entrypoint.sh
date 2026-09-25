#!/bin/sh
set -eu
umask 077
cache="${ORIGIN_CACHE:-/var/cache/origin}"
mkdir -p "$cache"
chmod 0700 "$cache"
exec python3 /app/server.py

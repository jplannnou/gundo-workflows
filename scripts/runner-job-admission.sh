#!/usr/bin/env bash
# GitHub Actions invokes this before the first job step.
set -Eeuo pipefail
lock_file=${GUNDO_DOCKER_CACHE_LOCK:-/run/lock/gundo-docker-cache-hygiene.lock}
if [[ ! -f "$lock_file" || ! -r "$lock_file" ]]; then printf 'CACHE_ADMISSION_REFUSED reason=lock-unavailable\n' >&2; exit 75; fi
# Read-only FD deliberately shares the root timer's 0644 inode. The hook never
# creates, truncates or changes permissions on its coordination lock.
exec 9<"$lock_file" || { printf 'CACHE_ADMISSION_REFUSED reason=lock-unavailable\n' >&2; exit 75; }
flock -s 9 || { printf 'CACHE_ADMISSION_REFUSED reason=lock-unavailable\n' >&2; exit 75; }
printf 'CACHE_ADMISSION_GRANTED\n'

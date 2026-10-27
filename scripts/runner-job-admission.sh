#!/usr/bin/env bash
# GitHub Actions invokes this before the first job step. Holding the shared
# lock only for admission lets an already-running cache cleaner finish, while
# its post-lock Runner.Worker check prevents a new cleanup from racing this job.
set -Eeuo pipefail

lock_file=${GUNDO_DOCKER_CACHE_LOCK:-/run/lock/gundo-docker-cache-hygiene.lock}
mkdir -p "$(dirname "$lock_file")"
exec 9>"$lock_file"
flock -s 9
printf 'CACHE_ADMISSION_GRANTED\n'

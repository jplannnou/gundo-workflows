#!/usr/bin/env bash
# Coordinated Docker cache hygiene for self-hosted Actions runners.
#
# This intentionally does nothing until every listener has loaded the admission
# hook. A deferred cleanup is healthy: it is never a CI failure and never
# mutates Docker state.
set -Eeuo pipefail

mode=${1:---dry-run}
case "$mode" in
  --dry-run|--apply) ;;
  *) echo "usage: $0 [--dry-run|--apply]" >&2; exit 64 ;;
esac

lock_file=${GUNDO_DOCKER_CACHE_LOCK:-/run/lock/gundo-docker-cache-hygiene.lock}
state_dir=${GUNDO_RUNNER_ADMISSION_STATE_DIR:-/etc/gundo/runner-docker-cache-admission}
proc_root=${GUNDO_PROC_ROOT:-/proc}
systemctl_bin=${GUNDO_SYSTEMCTL:-systemctl}
docker_bin=${GUNDO_DOCKER:-docker}
retention_policy=${GUNDO_DOCKER_RETENTION_POLICY:-/usr/local/lib/gundo-storage/docker_cache_retention.py}

defer() {
  printf 'CACHE_DEFERRED reason=%s\n' "$1"
  exit 0
}

worker_state() {
  [[ -d "$proc_root" && -r "$proc_root" ]] || return 2
  local proc comm count=0
  shopt -s nullglob
  for proc in "$proc_root"/[0-9]*; do
    comm="$proc/comm"
    # A process may disappear while scanning; that is not an unknown state.
    [[ -r "$comm" ]] || continue
    if [[ $(<"$comm") == 'Runner.Worker' ]]; then
      ((count += 1))
    fi
  done
  printf '%s\n' "$count"
}

read_manifest() {
  local file=$1
  [[ -s "$file" ]] || return 1
  LC_ALL=C sort -u "$file"
}

admission_ready() {
  local manifest="$state_dir/listeners" ready="$state_dir/ready"
  local expected actual unit
  expected=$(read_manifest "$manifest") || return 1
  actual=$(read_manifest "$ready") || return 1
  [[ "$expected" == "$actual" ]] || return 1
  while IFS= read -r unit; do
    [[ -n "$unit" ]] || continue
    "$systemctl_bin" is-active --quiet "$unit" || return 1
  done <<< "$expected"
}

workers=$(worker_state) || defer worker-state-unknown
(( workers == 0 )) || defer active-runner-worker
admission_ready || defer admission-not-ready

mkdir -p "$(dirname "$lock_file")"
exec 9>"$lock_file"
flock -n -x 9 || defer cache-cleaner-busy

# Recheck after obtaining exclusive access. A worker which reached its hook
# while this cleaner was waiting is now visible, closing the admission/GC gap.
workers=$(worker_state) || defer worker-state-unknown
(( workers == 0 )) || defer active-runner-worker
admission_ready || defer admission-not-ready

policy=$(
  timeout 30 "$retention_policy"
) || defer retention-policy-unavailable
until=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["until"])' <<< "$policy") || defer retention-policy-invalid
[[ -n "$until" ]] || defer retention-policy-invalid

printf 'CACHE_PLAN mode=%s image_prune_until=%s buildx_until=2h\n' "$mode" "$until"
if [[ "$mode" == '--dry-run' ]]; then
  exit 0
fi

timeout 30 "$docker_bin" version >/dev/null || defer docker-unavailable
timeout 300 "$docker_bin" image prune --all --force --filter "until=$until"
timeout 300 "$docker_bin" buildx prune --builder default --all --force --filter until=2h --max-used-space 30GB --reserved-space 15GB

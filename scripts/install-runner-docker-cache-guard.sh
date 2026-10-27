#!/usr/bin/env bash
# Installs the runner admission guard. Dry-run is the default; --apply never
# invokes Docker, prunes data, drains queues, changes groups or retags images.
set -Eeuo pipefail

mode=${1:---dry-run}
restart_idle=false
case "$mode" in
  --dry-run|--apply) ;;
  *) echo "usage: $0 [--dry-run|--apply] [--restart-idle-runners]" >&2; exit 64 ;;
esac
if [[ ${2:-} == '--restart-idle-runners' ]]; then restart_idle=true; fi
if [[ $# -gt 1 && ${2:-} != '--restart-idle-runners' ]]; then
  echo "usage: $0 [--dry-run|--apply] [--restart-idle-runners]" >&2; exit 64
fi

source_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
prefix=${GUNDO_INSTALL_PREFIX:-/usr/local}
systemd_dir=${GUNDO_SYSTEMD_DIR:-/etc/systemd/system}
state_dir=${GUNDO_RUNNER_ADMISSION_STATE_DIR:-/etc/gundo/runner-docker-cache-admission}
proc_root=${GUNDO_PROC_ROOT:-/proc}
systemctl_bin=${GUNDO_SYSTEMCTL:-systemctl}
hook="$prefix/bin/gundo-runner-job-admission.sh"
hygiene="$prefix/bin/runner-docker-cache-hygiene.sh"

mapfile -t units < <("$systemctl_bin" list-units --all --type=service --no-legend 'actions-runner@*.service' | awk '{print $1}' | LC_ALL=C sort -u)
(( ${#units[@]} > 0 )) || { echo 'RUNNER_GUARD_REFUSED no-runner-listeners'; exit 1; }

worker_count() {
  [[ -d "$proc_root" && -r "$proc_root" ]] || return 2
  local p count=0
  shopt -s nullglob
  for p in "$proc_root"/[0-9]*; do
    [[ -r "$p/comm" ]] || continue
    [[ $(<"$p/comm") == 'Runner.Worker' ]] && ((count += 1))
  done
  printf '%s\n' "$count"
}

plan() {
  printf 'RUNNER_GUARD_PLAN mode=%s hook=%s hygiene=%s state=%s\n' "$mode" "$hook" "$hygiene" "$state_dir"
  local unit
  for unit in "${units[@]}"; do
    printf 'RUNNER_GUARD_PLAN dropin=%s/%s.d/90-gundo-docker-cache-admission.conf\n' "$systemd_dir" "$unit"
  done
  printf 'RUNNER_GUARD_PLAN manifest=%s/listeners ready=%s/ready restart_idle=%s\n' "$state_dir" "$state_dir" "$restart_idle"
}

plan
[[ "$mode" == '--apply' ]] || exit 0

install -D -m 0755 "$source_dir/runner-job-admission.sh" "$hook"
install -D -m 0755 "$source_dir/runner-docker-cache-hygiene.sh" "$hygiene"
install -d -m 0755 "$state_dir"
printf '%s\n' "${units[@]}" | LC_ALL=C sort -u > "$state_dir/listeners"
rm -f "$state_dir/ready"
for unit in "${units[@]}"; do
  dropin="$systemd_dir/$unit.d/90-gundo-docker-cache-admission.conf"
  install -d -m 0755 "$(dirname "$dropin")"
  printf '[Service]\nEnvironment=ACTIONS_RUNNER_HOOK_JOB_STARTED=%s\n' "$hook" > "$dropin"
done
"$systemctl_bin" daemon-reload

# Configuration alone is deliberately not marked ready. Existing listener
# processes load their environment only after a restart. The cleaner remains
# fail-closed until this explicit, quiescent activation succeeds.
if ! "$restart_idle"; then
  printf 'RUNNER_GUARD_PENDING restart-idle-runners-required\n'
  exit 0
fi
workers=$(worker_count) || { echo 'RUNNER_GUARD_REFUSED worker-state-unknown'; exit 1; }
(( workers == 0 )) || { echo 'RUNNER_GUARD_REFUSED active-runner-worker'; exit 1; }
for unit in "${units[@]}"; do "$systemctl_bin" restart "$unit"; done
for unit in "${units[@]}"; do "$systemctl_bin" is-active --quiet "$unit"; done
printf '%s\n' "${units[@]}" | LC_ALL=C sort -u > "$state_dir/ready"
printf 'RUNNER_GUARD_READY listeners=%s\n' "${#units[@]}"

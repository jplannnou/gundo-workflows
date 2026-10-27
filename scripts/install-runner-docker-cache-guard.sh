#!/usr/bin/env bash
# Stages the cache-admission guard. It never starts Docker cleanup itself.
set -Eeuo pipefail

mode=${1:---dry-run}; activation=${2:-}; quiescence_token=${3:-}
case "$mode" in --dry-run|--apply) ;; *) echo "usage: $0 [--dry-run|--apply] [--activate-idle-runners TOKEN]" >&2; exit 64 ;; esac
if [[ -n "$activation" && "$activation" != '--activate-idle-runners' ]]; then echo "usage: $0 [--dry-run|--apply] [--activate-idle-runners TOKEN]" >&2; exit 64; fi
if [[ "$activation" == '--activate-idle-runners' && ( "$mode" != '--apply' || -z "$quiescence_token" ) ]]; then echo 'RUNNER_GUARD_REFUSED external-quiescence-token-required' >&2; exit 64; fi

source_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
prefix=${GUNDO_INSTALL_PREFIX:-/usr/local}
systemd_dir=${GUNDO_SYSTEMD_DIR:-/etc/systemd/system}
state_dir=${GUNDO_RUNNER_ADMISSION_STATE_DIR:-/etc/gundo/runner-docker-cache-admission}
proc_root=${GUNDO_PROC_ROOT:-/proc}
systemctl_bin=${GUNDO_SYSTEMCTL:-systemctl}
expected_listeners=${GUNDO_EXPECTED_RUNNER_LISTENERS:-22}
hook="$prefix/bin/gundo-runner-job-admission.sh"
hygiene="$prefix/bin/runner-docker-cache-hygiene.sh"

numeric_dirs() { local path; [[ -d "$proc_root" && -r "$proc_root" ]] || return 2; shopt -s nullglob; for path in "$proc_root"/[0-9]*; do [[ -d "$path" ]] && printf '%s\n' "${path##*/}"; done; }
proc_comm() { local file="$proc_root/$1/comm"; [[ -e "$file" ]] || return 3; [[ -r "$file" ]] || return 2; cat "$file"; }
proc_cgroup_unit() {
  local file="$proc_root/$1/cgroup" path unit
  [[ -e "$file" ]] || return 3; [[ -r "$file" ]] || return 2
  path=$(awk -F: 'NR == 1 { print $3; exit }' "$file") || return 2; [[ "$path" == */*.service ]] || return 2
  unit=${path##*/}; case "$unit" in actions-runner@*.service|personal-actions-runner@*.service) printf '%s\n' "$unit" ;; *) return 2 ;; esac
}
units() {
  local pid comm unit
  {
    "$systemctl_bin" list-units --all --type=service --no-legend 'actions-runner@*.service' | awk '{print $1}'
    "$systemctl_bin" list-units --all --type=service --no-legend 'personal-actions-runner@*.service' | awk '{print $1}'
    while IFS= read -r pid; do
      comm=$(proc_comm "$pid"); case $? in 0) ;; 3) continue ;; *) return 2 ;; esac
      [[ "$comm" == Runner.Listener ]] || continue
      unit=$(proc_cgroup_unit "$pid"); case $? in 0) printf '%s\n' "$unit" ;; 3) continue ;; *) return 2 ;; esac
    done < <(numeric_dirs)
  } | LC_ALL=C sort -u
}
worker_count() {
  local pid comm count=0
  [[ -d "$proc_root" && -r "$proc_root" ]] || return 2
  while IFS= read -r pid; do
    comm=$(proc_comm "$pid"); case $? in 0) ;; 3) continue ;; *) return 2 ;; esac
    if [[ "$comm" == Runner.Worker ]]; then count=$((count + 1)); fi
  done < <(numeric_dirs); printf '%s\n' "$count"
}
assert_quiescent() {
  [[ -r "$quiescence_token" ]] || return 1
  grep -Fxq 'GUNDO_RUNNER_QUIESCENT=1' "$quiescence_token" || return 1
  local workers; workers=$(worker_count) || return 1; (( workers == 0 ))
}
foreign_job_started_hook() {
  local unit=$1 current
  current=$("$systemctl_bin" show --property=Environment --value "$unit") || return 2
  [[ "$current" == *ACTIONS_RUNNER_HOOK_JOB_STARTED=* && "$current" != *"ACTIONS_RUNNER_HOOK_JOB_STARTED=$hook"* ]]
}
listener_has_loaded_hook() {
  local unit=$1 pid comm mapped env_file found=0
  while IFS= read -r pid; do
    comm=$(proc_comm "$pid"); case $? in 0) ;; 3) continue ;; *) return 2 ;; esac
    [[ "$comm" == Runner.Listener ]] || continue
    mapped=$(proc_cgroup_unit "$pid"); case $? in 0) ;; 3) continue ;; *) return 2 ;; esac
    [[ "$mapped" == "$unit" ]] || continue
    env_file="$proc_root/$pid/environ"; [[ -e "$env_file" && -r "$env_file" ]] || return 2
    tr '\0' '\n' < "$env_file" | grep -Fxq "ACTIONS_RUNNER_HOOK_JOB_STARTED=$hook" || return 1
    found=1
  done < <(numeric_dirs)
  (( found == 1 ))
}

mapfile -t listeners < <(units)
count=${#listeners[@]}
if [[ "$count" -ne "$expected_listeners" ]]; then printf 'RUNNER_GUARD_REFUSED listener-count expected=%s actual=%s\n' "$expected_listeners" "$count" >&2; exit 1; fi
for unit in "${listeners[@]}"; do
  hook_status=0; foreign_job_started_hook "$unit" || hook_status=$?
  if [[ "$hook_status" -eq 0 ]]; then
    printf 'RUNNER_GUARD_REFUSED foreign-job-started-hook unit=%s\n' "$unit" >&2; exit 1
  elif [[ "$hook_status" -ne 1 ]]; then
    printf 'RUNNER_GUARD_REFUSED job-started-hook-state-unknown unit=%s\n' "$unit" >&2; exit 1
  fi
done

printf 'RUNNER_GUARD_PLAN mode=%s hook=%s hygiene=%s state=%s listeners=%s\n' "$mode" "$hook" "$hygiene" "$state_dir" "$count"
for unit in "${listeners[@]}"; do printf 'RUNNER_GUARD_PLAN dropin=%s/%s.d/90-gundo-docker-cache-admission.conf\n' "$systemd_dir" "$unit"; done
printf 'RUNNER_GUARD_PLAN manifest=%s/listeners ready=%s/ready activation=%s\n' "$state_dir" "$state_dir" "${activation:-none}"
[[ "$mode" == '--apply' ]] || exit 0

install -D -m 0755 "$source_dir/runner-job-admission.sh" "$hook"
install -D -m 0755 "$source_dir/runner-docker-cache-hygiene.sh" "$hygiene"
install -d -m 0755 "$state_dir"
printf '%s\n' "${listeners[@]}" > "$state_dir/listeners"
rm -f "$state_dir/ready"
for unit in "${listeners[@]}"; do
  dropin="$systemd_dir/$unit.d/90-gundo-docker-cache-admission.conf"
  install -d -m 0755 "$(dirname "$dropin")"
  printf '[Service]\nEnvironment=ACTIONS_RUNNER_HOOK_JOB_STARTED=%s\n' "$hook" > "$dropin"
done
"$systemctl_bin" daemon-reload

# Staging is the safe default: old listeners have no ready marker, so GC stays
# deferred. Credential cleanup hooks are untouched because this drop-in adds
# only JOB_STARTED and rejects any existing foreign JOB_STARTED hook above.
if [[ -z "$activation" ]]; then printf 'RUNNER_GUARD_PENDING external-quiescence-token-required\n'; exit 0; fi
assert_quiescent || { echo 'RUNNER_GUARD_REFUSED quiescence-not-proven' >&2; exit 1; }
# The token is issued externally only after dispatch has been quiesced. Check
# again before every stop/start so an unexpected Worker aborts before it can be
# interrupted; all listeners are stopped before any one is started.
for unit in "${listeners[@]}"; do assert_quiescent || { echo 'RUNNER_GUARD_REFUSED active-runner-worker' >&2; exit 1; }; "$systemctl_bin" stop "$unit"; done
assert_quiescent || { echo 'RUNNER_GUARD_REFUSED active-runner-worker' >&2; exit 1; }
for unit in "${listeners[@]}"; do "$systemctl_bin" start "$unit"; "$systemctl_bin" is-active --quiet "$unit"; done
for unit in "${listeners[@]}"; do listener_has_loaded_hook "$unit" || { echo 'RUNNER_GUARD_REFUSED listener-environment-not-loaded' >&2; exit 1; }; done
printf '%s\n' "${listeners[@]}" > "$state_dir/ready"
printf 'RUNNER_GUARD_READY listeners=%s\n' "$count"

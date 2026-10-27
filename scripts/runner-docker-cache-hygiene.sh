#!/usr/bin/env bash
# Coordinated Docker cache hygiene for self-hosted Actions runners.
# A deferred run is successful and makes no Docker mutation.
set -Eeuo pipefail

mode=${1:---dry-run}
case "$mode" in --dry-run|--apply) ;; *) echo "usage: $0 [--dry-run|--apply]" >&2; exit 64 ;; esac
lock_file=${GUNDO_DOCKER_CACHE_LOCK:-/run/lock/gundo-docker-cache-hygiene.lock}
state_dir=${GUNDO_RUNNER_ADMISSION_STATE_DIR:-/etc/gundo/runner-docker-cache-admission}
proc_root=${GUNDO_PROC_ROOT:-/proc}
systemctl_bin=${GUNDO_SYSTEMCTL:-systemctl}
docker_bin=${GUNDO_DOCKER:-docker}
retention_policy=${GUNDO_DOCKER_RETENTION_POLICY:-/usr/local/lib/gundo-storage/docker_cache_retention.py}
expected_listeners=${GUNDO_EXPECTED_RUNNER_LISTENERS:-22}
hook_path=${GUNDO_JOB_STARTED_HOOK:-/usr/local/bin/gundo-runner-job-admission.sh}
fstrim_bin=${GUNDO_FSTRIM:-/usr/sbin/fstrim}
defer() { printf 'CACHE_DEFERRED reason=%s\n' "$1"; exit 0; }

numeric_dirs() { local path; [[ -d "$proc_root" && -r "$proc_root" ]] || return 2; shopt -s nullglob; for path in "$proc_root"/[0-9]*; do [[ -d "$path" ]] && printf '%s\n' "${path##*/}"; done; }
proc_comm() { local file="$proc_root/$1/comm"; [[ -e "$file" ]] || return 3; [[ -r "$file" ]] || return 2; cat "$file"; }
proc_cgroup_unit() {
  local file="$proc_root/$1/cgroup" path unit
  [[ -e "$file" ]] || return 3; [[ -r "$file" ]] || return 2
  path=$(awk -F: 'NR == 1 { print $3; exit }' "$file") || return 2
  [[ "$path" == */*.service ]] || return 2
  unit=${path##*/}
  case "$unit" in actions-runner@*.service|personal-actions-runner@*.service) printf '%s\n' "$unit" ;; *) return 2 ;; esac
}
discovered_units() {
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
worker_state() {
  local pid comm count=0
  [[ -d "$proc_root" && -r "$proc_root" ]] || return 2
  while IFS= read -r pid; do
    comm=$(proc_comm "$pid"); case $? in 0) ;; 3) continue ;; *) return 2 ;; esac
    if [[ "$comm" == Runner.Worker ]]; then count=$((count + 1)); fi
  done < <(numeric_dirs)
  printf '%s\n' "$count"
}
read_manifest() { [[ -s "$1" ]] || return 1; LC_ALL=C sort -u "$1"; }
has_expected_count() { local count; count=$(grep -cve '^$' <<< "$1"); [[ "$count" =~ ^[0-9]+$ && "$count" -eq "$expected_listeners" ]]; }
listener_has_loaded_hook() {
  local unit=$1 pid comm mapped found=0 env_file
  while IFS= read -r pid; do
    comm=$(proc_comm "$pid"); case $? in 0) ;; 3) continue ;; *) return 2 ;; esac
    [[ "$comm" == Runner.Listener ]] || continue
    mapped=$(proc_cgroup_unit "$pid"); case $? in 0) ;; 3) continue ;; *) return 2 ;; esac
    [[ "$mapped" == "$unit" ]] || continue
    env_file="$proc_root/$pid/environ"; [[ -e "$env_file" && -r "$env_file" ]] || return 2
    tr '\0' '\n' < "$env_file" | grep -Fxq "ACTIONS_RUNNER_HOOK_JOB_STARTED=$hook_path" || return 1
    found=1
  done < <(numeric_dirs)
  (( found == 1 )) || return 1
}
admission_ready() {
  local manifest="$state_dir/listeners" ready="$state_dir/ready" expected actual discovered unit
  expected=$(read_manifest "$manifest") || return 1; actual=$(read_manifest "$ready") || return 1; discovered=$(discovered_units) || return 2
  has_expected_count "$expected" && has_expected_count "$actual" && has_expected_count "$discovered" || return 1
  [[ "$expected" == "$actual" && "$expected" == "$discovered" ]] || return 1
  while IFS= read -r unit; do
    [[ -n "$unit" ]] || continue; "$systemctl_bin" is-active --quiet "$unit" || return 1; listener_has_loaded_hook "$unit" || return $?
  done <<< "$expected"
}

workers=$(worker_state) || defer worker-state-unknown
(( workers == 0 )) || defer active-runner-worker
admission_ready || defer admission-not-ready
# Only root's timer creates this inode. The hook opens it read-only so a 0644
# root-owned lock can be shared safely by unprivileged runner services.
if [[ ! -e "$lock_file" ]]; then install -D -m 0644 /dev/null "$lock_file"; fi
[[ -f "$lock_file" ]] || defer lock-invalid
chmod 0644 "$lock_file" || defer lock-permission-unavailable
exec 9>>"$lock_file" || defer lock-unavailable
flock -n -x 9 || defer cache-cleaner-busy
# A worker admitted while exclusive acquisition waited is now visible.
workers=$(worker_state) || defer worker-state-unknown
(( workers == 0 )) || defer active-runner-worker
admission_ready || defer admission-not-ready
policy=$(timeout 30 python3 -B "$retention_policy") || defer retention-policy-unavailable
until=$(python3 -c 'import json,sys; value=json.load(sys.stdin).get("until"); print(value if isinstance(value, int) and not isinstance(value, bool) else "")' <<< "$policy") || defer retention-policy-invalid
retention=$(python3 -c 'import json,sys; value=json.load(sys.stdin).get("retention_seconds"); print(value if isinstance(value, int) and not isinstance(value, bool) else "")' <<< "$policy") || defer retention-policy-invalid
[[ "$until" =~ ^[0-9]+$ && "$retention" =~ ^[0-9]+$ ]] || defer retention-policy-invalid
docker=("$docker_bin" --host unix:///var/run/docker.sock)
timeout 30 "${docker[@]}" version >/dev/null || defer docker-unavailable
help=$(timeout 30 "${docker[@]}" buildx prune --help) || defer buildx-unavailable
[[ "$help" == *--max-used-space* && "$help" == *--reserved-space* ]] || defer unsupported-buildx
printf 'CACHE_PLAN mode=%s image_retention_seconds=%s builder=default cache_max=30GB cache_reserve=15GB cache_retention=2h volumes=only-orphan-buildx-state\n' "$mode" "$retention"

# Preserve the existing narrow maintenance scope: only dangling builder-state
# volumes with the exact BuildKit name and at least one hour old are eligible.
orphan_builder_volumes() {
  local apply=$1 cutoff vol created created_s eligible=0 removed=0
  cutoff=$(( $(date +%s) - 3600 ))
  while IFS= read -r vol; do
    [[ "$vol" =~ ^buildx_buildkit_[A-Za-z0-9._-]+_state$ ]] || continue
    created=$(timeout 30 "${docker[@]}" volume inspect --format '{{.CreatedAt}}' "$vol" 2>/dev/null) || continue
    created_s=$(date -d "$created" +%s 2>/dev/null) || continue
    (( created_s <= cutoff )) || continue
    ((eligible += 1))
    if (( apply )) && timeout 60 "${docker[@]}" volume rm "$vol" >/dev/null 2>&1; then ((removed += 1)); fi
  done < <(timeout 60 "${docker[@]}" volume ls --filter dangling=true --format '{{.Name}}')
  printf 'ORPHAN_BUILDER_VOLUMES eligible=%s removed=%s apply=%s\n' "$eligible" "$removed" "$apply"
}

if [[ "$mode" == '--dry-run' ]]; then orphan_builder_volumes 0; exit 0; fi
before=$(df -B1 --output=used / | tail -n 1 | tr -d ' ') || defer disk-usage-unavailable
[[ "$before" =~ ^[0-9]+$ ]] || defer disk-usage-invalid
timeout 300 "${docker[@]}" image prune --all --force --filter "until=$until"
timeout 300 "${docker[@]}" buildx prune --builder default --all --force --filter until=2h --max-used-space 30GB --reserved-space 15GB
orphan_builder_volumes 1
sync
timeout 60 "$fstrim_bin" / >/dev/null || defer fstrim-unavailable
after=$(df -B1 --output=used / | tail -n 1 | tr -d ' ') || defer disk-usage-unavailable
[[ "$after" =~ ^[0-9]+$ ]] || defer disk-usage-invalid
printf 'CACHE_DONE used_before=%s used_after=%s net_reclaimed=%s windows_compaction=separate\n' "$before" "$after" "$((before - after))"

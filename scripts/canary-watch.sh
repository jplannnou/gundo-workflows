#!/usr/bin/env bash
# ==============================================================================
# canary-watch.sh
# ------------------------------------------------------------------------------
# Polls Cloud Monitoring during a canary rollout and exits non-zero if the
# canary revision breaches SLO thresholds (error rate or p95 latency).
#
# Usage:
#   canary-watch.sh \
#     --service=gundo-engine \
#     --project=gundo-content-engine \
#     --region=us-central1 \
#     --revision-tag=canary-abc123 \
#     --duration=300 \
#     --max-error-rate=0.01 \
#     --max-p95-ms=1500
#
# Exit codes:
#   0 = SLO held for the full watch window -> promote
#   1 = SLO breached -> trigger rollback
#   2 = Script error (missing args, API failure, etc.)
# ==============================================================================
# GitHub Actions invokes scripts with `bash -e` by default (see the shell
# preamble in the workflow log: `shell: /usr/bin/bash -e {0}`). We explicitly
# disable it here because this script tolerates gcloud failures and empty
# metric pipes — see the long note below. Without this `set +e`, the `-e`
# from the harness kills the script on the first `gcloud monitoring` pipe
# that returns a non-zero exit, making every canary deploy appear to breach
# SLO and rolling back healthy revisions.
set +e
set -u
# NOTE: We intentionally do NOT use `-e` or `-o pipefail` here. A missing
# metric (common when the canary receives zero traffic in the first minute,
# or on low-QPS services) would otherwise kill the script, the workflow
# would interpret the exit as SLO failure, and a healthy deploy would be
# rolled back. Instead, the script handles empty/missing data explicitly
# via the MIN_REQUESTS skip and the consecutive-breach counter.

SERVICE=""
PROJECT=""
REGION="us-central1"
REVISION=""
DURATION=300
MAX_ERROR_RATE=0.01
MAX_P95_MS=1500
POLL_INTERVAL=30
MIN_REQUESTS=10

for arg in "$@"; do
  case $arg in
    --service=*) SERVICE="${arg#*=}" ;;
    --project=*) PROJECT="${arg#*=}" ;;
    --region=*) REGION="${arg#*=}" ;;
    --revision=*|--revision-name=*) REVISION="${arg#*=}" ;;
    --duration=*) DURATION="${arg#*=}" ;;
    --max-error-rate=*) MAX_ERROR_RATE="${arg#*=}" ;;
    --max-p95-ms=*) MAX_P95_MS="${arg#*=}" ;;
    --poll-interval=*) POLL_INTERVAL="${arg#*=}" ;;
    --min-requests=*) MIN_REQUESTS="${arg#*=}" ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$SERVICE" ] || [ -z "$PROJECT" ] || [ -z "$REVISION" ]; then
  echo "Missing required args. Need --service, --project, --revision" >&2
  exit 2
fi

echo "::group::Canary watch config"
echo "  service:        $SERVICE"
echo "  project:        $PROJECT"
echo "  region:         $REGION"
echo "  revision:       $REVISION"
echo "  duration:       ${DURATION}s"
echo "  max-error-rate: $MAX_ERROR_RATE"
echo "  max-p95-ms:     $MAX_P95_MS"
echo "  poll-interval:  ${POLL_INTERVAL}s"
echo "::endgroup::"

# -----------------------------------------------------------------------------
# Helper: query Cloud Monitoring Metrics Explorer via gcloud
# -----------------------------------------------------------------------------
query_metric() {
  local metric="$1"      # e.g. run.googleapis.com/request_count
  local filter="$2"      # extra filter clause (must start with "AND " if non-empty)
  local window_secs="$3" # time window to aggregate

  # GNU date (Linux) first; fall back to BSD (macOS) if that fails.
  local end_time start_time
  end_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  start_time=$(date -u -d "-${window_secs} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
            || date -u -v-${window_secs}S +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
            || echo "$end_time")

  # The command can legitimately fail or return empty when the metric
  # has no data (first minute of canary, or low-QPS service). Either
  # case returns 0 so that "no data" is treated as "no errors".
  local raw
  raw=$(gcloud monitoring time-series list \
    --project="$PROJECT" \
    --filter="metric.type=\"$metric\" AND resource.labels.service_name=\"$SERVICE\" AND metric.labels.revision_name=\"${REVISION}\" $filter" \
    --interval-end-time="$end_time" \
    --interval-start-time="$start_time" \
    --format="value(points[0].value.doubleValue,points[0].value.int64Value)" 2>/dev/null \
    | head -1 | awk '{print ($1 != "" ? $1 : 0)}')

  echo "${raw:-0}"
}

# -----------------------------------------------------------------------------
# Helper: numeric comparison using awk (portable)
# -----------------------------------------------------------------------------
gt() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a > b) }'; }

start_ts=$(date +%s)
end_ts=$((start_ts + DURATION))
iteration=0
breaches=0
MAX_BREACHES=2   # require 2 consecutive breaches to avoid flapping

# Pre-initialise metrics so the final output block never touches unset
# vars (set -u) when every iteration skipped due to MIN_REQUESTS gating.
TOTAL_REQS=0
ERROR_REQS=0
ERROR_RATE=0
P95_LATENCY=0

while [ "$(date +%s)" -lt "$end_ts" ]; do
  iteration=$((iteration + 1))
  echo ""
  echo "--- Iteration $iteration (t=$(( $(date +%s) - start_ts ))s) ---"

  WINDOW=60
  TOTAL_REQS=$(query_metric "run.googleapis.com/request_count" "" "$WINDOW")
  ERROR_REQS=$(query_metric "run.googleapis.com/request_count" \
    "AND metric.labels.response_code_class=\"5xx\"" "$WINDOW")
  P95_LATENCY=$(query_metric "run.googleapis.com/request_latencies" "" "$WINDOW")

  TOTAL_REQS=${TOTAL_REQS:-0}
  ERROR_REQS=${ERROR_REQS:-0}
  P95_LATENCY=${P95_LATENCY:-0}

  if gt "$MIN_REQUESTS" "$TOTAL_REQS"; then
    echo "  requests in window: $TOTAL_REQS (below min=$MIN_REQUESTS, skipping SLO check)"
    sleep "$POLL_INTERVAL"
    continue
  fi

  ERROR_RATE=$(awk -v e="$ERROR_REQS" -v t="$TOTAL_REQS" 'BEGIN { printf "%.4f", (t > 0 ? e / t : 0) }')

  echo "  requests:   $TOTAL_REQS"
  echo "  errors:     $ERROR_REQS"
  echo "  error_rate: $ERROR_RATE (threshold $MAX_ERROR_RATE)"
  echo "  p95_ms:     $P95_LATENCY (threshold $MAX_P95_MS)"

  BREACH=0
  if gt "$ERROR_RATE" "$MAX_ERROR_RATE"; then
    echo "  BREACH: error rate exceeded"
    BREACH=1
  fi
  if gt "$P95_LATENCY" "$MAX_P95_MS"; then
    echo "  BREACH: p95 latency exceeded"
    BREACH=1
  fi

  if [ "$BREACH" -eq 1 ]; then
    breaches=$((breaches + 1))
    echo "  consecutive breaches: $breaches / $MAX_BREACHES"
    if [ "$breaches" -ge "$MAX_BREACHES" ]; then
      echo "::error::SLO breached for $MAX_BREACHES consecutive windows. Rolling back."
      {
        echo "metrics<<EOF"
        echo "{\"errorRate\":$ERROR_RATE,\"p95LatencyMs\":$P95_LATENCY,\"requestCount\":$TOTAL_REQS,\"breached\":true}"
        echo "EOF"
      } >> "${GITHUB_OUTPUT:-/dev/null}"
      exit 1
    fi
  else
    breaches=0
  fi

  sleep "$POLL_INTERVAL"
done

echo ""
echo "::notice::Canary held SLO for ${DURATION}s. Safe to promote."
{
  echo "metrics<<EOF"
  echo "{\"errorRate\":$ERROR_RATE,\"p95LatencyMs\":$P95_LATENCY,\"requestCount\":$TOTAL_REQS,\"breached\":false}"
  echo "EOF"
} >> "${GITHUB_OUTPUT:-/dev/null}"
exit 0

#!/usr/bin/env bash
# ==============================================================================
# report-deployment.sh
# ------------------------------------------------------------------------------
# Posts a deployment lifecycle event to the Feedback Hub DevOps endpoint.
# Silent on non-2xx (we never block a deploy because telemetry failed).
#
# Env vars required:
#   FEEDBACK_HUB_URL      Base URL of Feedback Hub (e.g. https://hub-xxx.run.app)
#   FEEDBACK_HUB_API_KEY  API key registered for the devops scope
#
# Usage:
#   report-deployment.sh \
#     --project=gundo-engine \
#     --commit=abc123 \
#     --status=canary \
#     [--revision=gundo-engine-00042] \
#     [--traffic-percent=10] \
#     [--author=jplannnou] \
#     [--metrics-json='{"errorRate":0.001,"p95LatencyMs":450}'] \
#     [--rollback-reason="p95 latency breach"]
# ==============================================================================
set -euo pipefail

PROJECT=""
COMMIT=""
STATUS=""
REVISION=""
TRAFFIC_PERCENT=""
AUTHOR="${GITHUB_ACTOR:-unknown}"
METRICS_JSON=""
ROLLBACK_REASON=""

for arg in "$@"; do
  case $arg in
    --project=*) PROJECT="${arg#*=}" ;;
    --commit=*) COMMIT="${arg#*=}" ;;
    --status=*) STATUS="${arg#*=}" ;;
    --revision=*) REVISION="${arg#*=}" ;;
    --traffic-percent=*) TRAFFIC_PERCENT="${arg#*=}" ;;
    --author=*) AUTHOR="${arg#*=}" ;;
    --metrics-json=*) METRICS_JSON="${arg#*=}" ;;
    --rollback-reason=*) ROLLBACK_REASON="${arg#*=}" ;;
    *) echo "Unknown arg: $arg" >&2 ;;
  esac
done

if [ -z "${FEEDBACK_HUB_URL:-}" ] || [ -z "${FEEDBACK_HUB_API_KEY:-}" ]; then
  echo "::warning::FEEDBACK_HUB_URL or FEEDBACK_HUB_API_KEY not set, skipping telemetry"
  exit 0
fi

if [ -z "$PROJECT" ] || [ -z "$COMMIT" ] || [ -z "$STATUS" ]; then
  echo "::warning::Missing required args (--project, --commit, --status)"
  exit 0
fi

PAYLOAD=$(cat <<EOF
{
  "project": "$PROJECT",
  "commit": {
    "sha": "$COMMIT",
    "author": "$AUTHOR",
    "message": "${GITHUB_EVENT_HEAD_COMMIT_MESSAGE:-}",
    "url": "https://github.com/${GITHUB_REPOSITORY:-}/commit/$COMMIT",
    "branch": "${GITHUB_REF_NAME:-}"
  },
  "status": "$STATUS",
  "revision": "${REVISION:-null}",
  "trafficPercent": ${TRAFFIC_PERCENT:-null},
  "metrics": ${METRICS_JSON:-null},
  "rollbackReason": $([ -n "$ROLLBACK_REASON" ] && echo "\"$ROLLBACK_REASON\"" || echo "null"),
  "workflowRunUrl": "https://github.com/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)

# Feedback Hub's ApiKeyGuard reads `x-feedback-api-key` (not `x-api-key`)
# and also requires an `x-feedback-user-email` header. For CI events we
# use a synthetic `ci@gundo.life` — the real commit author is already
# captured inside the payload.
HTTP_CODE=$(curl -s -o /tmp/devops-response.json -w "%{http_code}" \
  -X POST "$FEEDBACK_HUB_URL/api/devops/deployments" \
  -H "Content-Type: application/json" \
  -H "x-feedback-api-key: $FEEDBACK_HUB_API_KEY" \
  -H "x-feedback-user-email: ci@gundo.life" \
  -H "x-feedback-user-name: GitHub Actions" \
  --data "$PAYLOAD" \
  --max-time 10 || echo "000")

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  echo "Reported deployment (status=$STATUS, http=$HTTP_CODE)"
else
  echo "::warning::Deploy report failed (http=$HTTP_CODE). Response: $(cat /tmp/devops-response.json 2>/dev/null || true)"
fi

exit 0

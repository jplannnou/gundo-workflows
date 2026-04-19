#!/usr/bin/env bash
# ==============================================================================
# cleanup-pr-tags.sh
# ------------------------------------------------------------------------------
# Removes the Cloud Run revision tag `pr-<number>` when a PR closes. Keeps
# revisions around (for quick re-tag) but frees the tag so it can be reused.
#
# Usage (typically invoked by a pull_request: closed workflow):
#   cleanup-pr-tags.sh \
#     --service=gundo-engine \
#     --project=gundo-content-engine \
#     --region=us-central1 \
#     --pr-number=123
# ==============================================================================
set -euo pipefail

SERVICE=""
PROJECT=""
REGION="us-central1"
PR_NUMBER=""

for arg in "$@"; do
  case $arg in
    --service=*) SERVICE="${arg#*=}" ;;
    --project=*) PROJECT="${arg#*=}" ;;
    --region=*) REGION="${arg#*=}" ;;
    --pr-number=*) PR_NUMBER="${arg#*=}" ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$SERVICE" ] || [ -z "$PROJECT" ] || [ -z "$PR_NUMBER" ]; then
  echo "Missing required args" >&2
  exit 2
fi

PR_TAG="pr-$PR_NUMBER"

# Remove the tag; non-fatal if it doesn't exist
gcloud run services update-traffic "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT" \
  --remove-tags="$PR_TAG" || echo "Tag $PR_TAG not present"

echo "Removed tag $PR_TAG from $SERVICE"

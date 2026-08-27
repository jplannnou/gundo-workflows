#!/usr/bin/env bash
set -euo pipefail

readonly WORKFLOW='.github/workflows/reusable-deploy-cloudrun.yml'
readonly FEEDBACK_HUB_URL='https://gundo-feedback-api-744494884826.us-central1.run.app'
readonly RETIRED_FEEDBACK_HUB_URL='https://gundo-content-engine-xlpp333cua-uc.a.run.app'

if ! grep -Fq "default: '$FEEDBACK_HUB_URL'" "$WORKFLOW"; then
  echo "::error file=$WORKFLOW::Feedback Hub default must point to the live gundo-feedback-api service"
  exit 1
fi

if grep -RFn "$RETIRED_FEEDBACK_HUB_URL" .github actions docs README.md; then
  echo '::error::Retired Feedback Hub service URL is still referenced'
  exit 1
fi

legacy_google_actions=$(grep -REn 'google-github-actions/(auth|setup-gcloud)@v[012]([^0-9]|$)' .github || true)
if [[ -n "$legacy_google_actions" ]]; then
  printf '%s\n' "$legacy_google_actions"
  echo '::error::Google GitHub Actions must use a Node 24-compatible major'
  exit 1
fi

echo 'Workflow contracts are current.'

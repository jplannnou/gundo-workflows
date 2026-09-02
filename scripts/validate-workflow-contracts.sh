#!/usr/bin/env bash
set -euo pipefail

readonly WORKFLOW='.github/workflows/reusable-deploy-cloudrun.yml'
readonly PRIVATE_SECURITY_WORKFLOW="${PRIVATE_SECURITY_WORKFLOW:-.github/workflows/reusable-private-security.yml}"
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

private_security_source="$(< "$PRIVATE_SECURITY_WORKFLOW")"

if ! grep -Fq 'runs-on: [self-hosted, "${{ inputs.runner-label }}"]' <<< "$private_security_source"; then
  echo "::error file=$PRIVATE_SECURITY_WORKFLOW::Private scans must always require a self-hosted runner"
  exit 1
fi

if grep -En 'runs-on:.*(ubuntu|windows|macos)-' <<< "$private_security_source"; then
  echo "::error file=$PRIVATE_SECURITY_WORKFLOW::Private scans must not use GitHub-hosted runners"
  exit 1
fi

if grep -En '(security-events:|upload-sarif|codeql-action)' <<< "$private_security_source"; then
  echo "::error file=$PRIVATE_SECURITY_WORKFLOW::Private scans must not depend on paid GHAS/SARIF upload"
  exit 1
fi

if grep -En 'uses: [^ ]+@(master|main|v[0-9]+([.]|$))' <<< "$private_security_source"; then
  echo "::error file=$PRIVATE_SECURITY_WORKFLOW::Third-party actions must be pinned to a full commit SHA"
  exit 1
fi

for contract in 'fetch-depth: 0' 'trivy fs' '--include-dev-deps' 'gitleaks git' 'GUNDO_SYNTHETIC_SECRET' 'issues: write' 'escaneo local fallido'; do
  if ! grep -Fq -- "$contract" <<< "$private_security_source"; then
    echo "::error file=$PRIVATE_SECURITY_WORKFLOW::Missing private security contract: $contract"
    exit 1
  fi
done

# Ningun reusable puede resolver a un runner de pago. Tres invariantes, todas
# fail-closed, porque el fallo que las motiva era invisible: `lint-reusable.yml`
# tenia `default: ubuntu-latest` en el input `runner`, y los consumidores que se
# olvidaban de declararlo se iban a minutos facturados sin ninguna senal en su
# propio YAML. Solo se veia mirando `runner_name` en los jobs ya ejecutados.
shopt -s nullglob
for reusable in .github/workflows/reusable-*.yml; do
  if grep -En '^ *runs-on:.*(ubuntu|windows|macos)-' "$reusable"; then
    echo "::error file=$reusable::Los reusables no pueden usar runners GitHub-hosted"
    exit 1
  fi

  if ! grep -Eq '^ *runs-on: \[self-hosted' "$reusable"; then
    echo "::error file=$reusable::runs-on debe empezar por [self-hosted, ...] para no poder caer en un runner de pago"
    exit 1
  fi

  if grep -A8 -E '^      runner(-label)?:' "$reusable" | grep -Eq "default: *['\"]?(ubuntu|windows|macos)-"; then
    echo "::error file=$reusable::El input de runner no puede tener default alojado; usa required: true"
    exit 1
  fi
done
shopt -u nullglob

echo 'Workflow contracts are current.'

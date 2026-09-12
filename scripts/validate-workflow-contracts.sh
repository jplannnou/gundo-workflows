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

# Ningun job puede descargar de raw.githubusercontent.com si el runner ya trae
# la herramienta. `setup-gcloud` con su version por defecto (`latest`) baja de
# ahi `versions.json` en cada job, y `cosign-installer` baja la clave publica de
# la release. Ese host responde `503 Backend.max_conn reached` a la IP de la
# workstation que comparten los runners locales: el 12-sep-2026 tumbo los cuatro
# intentos del deploy de genie-api (run 34713082782).
#
# Contrato, paso a paso y dentro del MISMO job:
#   - un paso de deteccion con `id:` que compruebe la herramienta
#     (`gcloud version`; para cosign, `cosign version`) y este ANTES;
#   - setup-gcloud con `skip_install: ${{ steps.<id>.outputs.gcloud == 'true' }}`;
#   - cosign-installer con `if: steps.<id>.outputs.cosign != 'true'`.
# La misma regla la aplica a diario la auditoria del org en genie-api
# (`scripts/ci/audit-runner-policy.mjs`); aqui corta el PR antes de llegar a `v1`,
# que es una rama y la consumen todos los repos en cuanto se mergea.
raw_download_violations() {
  awk -v q="'" '
    function indent(s) { match(s, /^ */); return RLENGTH }
    function blank(s) { return s ~ /^[ \t]*(#.*)?$/ }
    function step_start(n) { while (n > 0 && L[n] !~ /^[ \t]*- /) n--; return n }
    function step_end(n,   d) {
      d = indent(L[n]); n++
      while (n <= NR && (blank(L[n]) || indent(L[n]) > d)) n++
      return n
    }
    { line = $0; sub(/\r$/, "", line); L[NR] = line }
    END {
      in_jobs = 0; job = ""
      for (i = 1; i <= NR; i++) {
        if (L[i] ~ /^jobs:/) in_jobs = 1
        else if (L[i] ~ /^[^ \t#]/) in_jobs = 0
        else if (in_jobs && L[i] ~ /^  [A-Za-z0-9_-]+:[ \t]*(#.*)?$/) {
          job = L[i]; sub(/^  /, "", job); sub(/:.*$/, "", job)
        }
        J[i] = job
      }
      quoted = "[\"" q "]?"
      for (i = 1; i <= NR; i++) {
        if (L[i] ~ /^[ \t]*#/) continue
        if (L[i] ~ ("^[ \t]*(- +)?uses:[ \t]*" quoted "google-github-actions/setup-gcloud@")) {
          wired = "^[ \t]*skip_install:[ \t]*" quoted "[$][{][{][ \t]*steps[.][A-Za-z0-9_-]+[.]outputs[.]gcloud[ \t]*==[ \t]*" q "true" q
          # `gcloud version` y no `command -v gcloud`: este ultimo aparece
          # tambien en los `echo` informativos y no probaria nada.
          probe = "gcloud[ \t]+version"
        } else if (L[i] ~ ("^[ \t]*(- +)?uses:[ \t]*" quoted "sigstore/cosign-installer@")) {
          wired = "^[ \t]*(- +)?if:[ \t]*" quoted "([$][{][{][ \t]*)?steps[.][A-Za-z0-9_-]+[.]outputs[.]cosign[ \t]*!=[ \t]*" q "true" q
          probe = "cosign[ \t]+version"
        } else continue

        s = step_start(i); e = step_end(s); id = ""
        for (k = s; k < e; k++) {
          if (L[k] ~ wired) { id = L[k]; sub(/^.*steps[.]/, "", id); sub(/[.]outputs.*$/, "", id) }
        }
        ok = 0
        if (id != "") {
          for (k = 1; k < s; k++) {
            if (J[k] != J[i] || L[k] !~ ("^[ \t]*(- +)?id:[ \t]*" quoted id quoted "[ \t]*$")) continue
            ds = step_start(k); de = step_end(ds)
            for (m = ds; m < de; m++) if (L[m] ~ probe) ok = 1
          }
        }
        if (!ok) printf "%s:%d: %s\n", FILENAME, i, L[i]
      }
    }
  ' "$1"
}

raw_downloads=''
for workflow in .github/workflows/*.yml; do
  found=$(raw_download_violations "$workflow")
  if [[ -n "$found" ]]; then
    raw_downloads+="${found}"$'\n'
  fi
done
if [[ -n "$raw_downloads" ]]; then
  printf '%s\n' "$raw_downloads"
  echo '::error::setup-gcloud y cosign-installer deben saltarse la descarga cuando el runner ya trae la herramienta (paso de deteccion + skip_install / if)'
  exit 1
fi

echo 'Workflow contracts are current.'

#!/usr/bin/env bash
# Prueba de mutacion del validador de contratos.
#
# Una guarda que nunca se ha visto fallar no demuestra nada. Este script copia el
# repo a un directorio temporal, rompe a proposito un contrato cada vez y exige
# que `validate-workflow-contracts.sh` falle; y exige que pase sin mutar.
# Si alguien borra o debilita una regla, la mutacion correspondiente pasa y este
# script falla.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fresh_copy() {
  rm -rf "$work/repo"
  mkdir -p "$work/repo"
  cp -R "$repo_root/.github" "$repo_root/scripts" "$work/repo/"
  for extra in actions docs README.md; do
    [[ -e "$repo_root/$extra" ]] && cp -R "$repo_root/$extra" "$work/repo/"
  done
}

validate() {
  (cd "$work/repo" && bash scripts/validate-workflow-contracts.sh) > "$work/out.txt" 2>&1
}

failures=0

fresh_copy
if validate; then
  echo "ok   sin mutar: el validador pasa"
else
  echo "FAIL sin mutar: el validador deberia pasar"
  cat "$work/out.txt"
  failures=$((failures + 1))
fi

# Cada mutacion: nombre # archivo # texto literal a sustituir # sustituto.
# Si el sustituto deja la linea vacia, la linea se borra.
mutations=(
  "setup-gcloud sin skip_install#reusable-preview.yml#skip_install: \${{ steps.runner-tools.outputs.gcloud == 'true' }}#"
  "skip_install fijo a true#reusable-deploy-firebase.yml#skip_install: \${{ steps.runner-tools.outputs.gcloud == 'true' }}#skip_install: true"
  "cosign-installer sin if#reusable-build-sign.yml#if: steps.runner-tools.outputs.cosign != 'true'#"
  "deteccion sin comprobar gcloud#reusable-deploy-cloudrun.yml#gcloud_version=\$(gcloud version --format='value(\"Google Cloud SDK\")' 2>/dev/null || true)#gcloud_version=577.0.0"
  "deteccion sin comprobar cosign#reusable-build-sign.yml#cosign_version=\$(cosign version 2>/dev/null || true)#cosign_version='GitVersion: v2.4.1'"
  "id de deteccion distinto#reusable-preview.yml#id: runner-tools#id: otra-cosa"
)

for mutation in "${mutations[@]}"; do
  IFS='#' read -r name file from to <<< "$mutation"
  fresh_copy
  target="$work/repo/.github/workflows/$file"
  if ! grep -Fq -- "$from" "$target"; then
    echo "FAIL $name: el texto a mutar ya no existe en $file (actualiza la prueba)"
    failures=$((failures + 1))
    continue
  fi
  FROM="$from" TO="$to" awk '
    BEGIN { from = ENVIRON["FROM"]; to = ENVIRON["TO"] }
    {
      at = index($0, from)
      if (at > 0) {
        replaced = substr($0, 1, at - 1) to substr($0, at + length(from))
        if (replaced ~ /^[ \t]*$/) next
        print replaced
        next
      }
      print
    }
  ' "$target" > "$target.tmp"
  mv "$target.tmp" "$target"
  if validate; then
    echo "FAIL $name: la mutacion paso el validador (la guarda no muerde)"
    failures=$((failures + 1))
  else
    echo "ok   $name: el validador la rechaza"
  fi
done

if (( failures > 0 )); then
  echo "::error::$failures comprobacion(es) de mutacion fallaron"
  exit 1
fi
echo 'Mutation checks passed.'

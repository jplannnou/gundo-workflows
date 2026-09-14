#!/usr/bin/env bash
# Prueba de mutacion del validador de contratos.
#
# Una guarda que nunca se ha visto fallar no demuestra nada. Este script copia el
# repo a un directorio temporal, rompe a proposito un contrato cada vez y exige
# que `validate-workflow-contracts.sh` falle; y exige que pase sin mutar.
# Si alguien borra o debilita una regla, la mutacion correspondiente pasa el
# validador y este script falla.
#
# Cubre las reglas de descargas de raw.githubusercontent.com (#36): ese dominio
# devolvio 503 a la IP de los runners locales el 12-09-2026 y tumbo despliegues.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fresh_copy() {
  rm -rf "$work/repo"
  mkdir -p "$work/repo"
  cp -R "$repo_root/.github" "$repo_root/scripts" "$work/repo/"
  for extra in actions docs README.md; do
    if [[ -e "$repo_root/$extra" ]]; then
      cp -R "$repo_root/$extra" "$work/repo/"
    fi
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

# Cada mutacion: nombre | archivo | texto literal a sustituir | sustituto |
# error que debe dar el validador. Se exige el error concreto, no un fallo
# cualquiera: si la mutacion la cazara otra regla por casualidad, la regla que
# se prueba podria estar rota sin que nadie lo viera.
# Si el sustituto deja la linea vacia, la linea se borra.
mutations=(
  "setup-gcloud sin skip_install|reusable-preview.yml|skip_install: true||setup-gcloud sin skip_install: true"
  "skip_install a false|reusable-deploy-firebase.yml|skip_install: true|skip_install: false|setup-gcloud sin skip_install: true"
  "vuelve sigstore/cosign-installer|reusable-build-sign.yml|- name: Install Cosign|- uses: sigstore/cosign-installer@v3|Descarga fragil de raw.githubusercontent.com"
  "cosign desde raw.githubusercontent.com|reusable-deploy-cloudrun.yml|https://github.com/sigstore/cosign/releases/download/|https://raw.githubusercontent.com/sigstore/cosign/|Descarga fragil de raw.githubusercontent.com"
)

for mutation in "${mutations[@]}"; do
  IFS='|' read -r name file from to expected <<< "$mutation"
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
  elif ! grep -Fq -- "$expected" "$work/out.txt"; then
    echo "FAIL $name: el validador fallo, pero no con '$expected'"
    cat "$work/out.txt"
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

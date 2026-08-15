#!/usr/bin/env bash
# ==============================================================================
# sweep-canary-tags.sh
# ------------------------------------------------------------------------------
# Retira de un servicio de Cloud Run los tags `canary-*` HUÉRFANOS: los que
# quedaron colgados de un despliegue que nunca terminó de limpiar lo suyo.
#
# ¿Por qué hace falta un barrido, si el workflow ya se limpia solo?
#
#   Toda la limpieza que existía hasta ahora es AUTOLIMPIEZA: cada run retira
#   únicamente SU propio `canary-<sha>` (en la promoción, en el rollback y en
#   el step `always()` de cierre). Eso cubre los finales ordenados, pero no
#   cubre el caso en el que el job entero deja de existir antes de llegar al
#   cierre — el runner self-hosted se apaga, la máquina reinicia, un
#   `gcloud run deploy` se queda horas colgado del plano de control y el job
#   se cancela por timeout. En esos caminos ningún step corre, ni siquiera
#   los `always()`.
#
#   Y como ningún run mira nunca los tags de OTROS runs, un solo escape se
#   vuelve permanente: el tag se queda ahí para siempre. Por eso seguían vivos
#   28 tags huérfanos en agosto de 2026 (17 en genie-ui de mayo, 11 en
#   genie-api del 10-11 de julio) pese a tres arreglos previos de
#   autolimpieza. Este script convierte "un escape = huérfano eterno" en
#   "un escape = se cura en el siguiente despliegue".
#
# SEGURIDAD — el script solo retira un tag si se cumple TODO:
#   1. El nombre empieza por el prefijo (`canary-` por defecto).
#   2. La entrada de tráfico está al 0%. Nunca se toca un tag que esté
#      sirviendo: eso movería tráfico de producción.
#   3. La revisión a la que apunta tiene más de `--min-age-minutes` (60 por
#      defecto). Protege el canary de un despliegue simultáneo durante la
#      ventana en la que ya tiene tag pero todavía está al 0%.
#   4. No es el tag pasado en `--keep-tag`.
#
# ⚠️ `gcloud run services update-traffic --remove-tags` vuelve a serializar la
# config del servicio y SE LLEVA POR DELANTE el binding público
# `allUsers/roles/run.invoker` (incidente
# `incident-cloud-run-remove-tags-strips-iam-2026-05-08.md`, 4 recurrencias).
# Dentro del reusable eso lo recoge el step `Re-bind public access (always,
# post-update-traffic)`. Si lo ejecutas A MANO contra un servicio PÚBLICO,
# vuelve a atar el binding después:
#
#   gcloud run services add-iam-policy-binding SERVICIO \
#     --region=REGION --project=PROYECTO \
#     --member=allUsers --role=roles/run.invoker
#
# El script te lo recuerda al final cuando retira algo.
#
# Uso — por defecto NO toca nada (dry-run), hay que pedir `--apply`:
#
#   # ver qué se retiraría
#   scripts/sweep-canary-tags.sh \
#     --service=genie-api --project=project-genie-ue --region=europe-west1
#
#   # retirarlos de verdad
#   scripts/sweep-canary-tags.sh \
#     --service=genie-api --project=project-genie-ue --region=europe-west1 --apply
#
# Salidas: 0 = nada que hacer o barrido verificado. 1 = quedaron tags tras
# aplicar. 2 = error de uso.
# ==============================================================================
set -uo pipefail

SERVICE=""
PROJECT=""
REGION=""
PREFIX="canary-"
KEEP_TAG=""
MIN_AGE_MINUTES=60
APPLY="false"

for arg in "$@"; do
  case $arg in
    --service=*) SERVICE="${arg#*=}" ;;
    --project=*) PROJECT="${arg#*=}" ;;
    --region=*) REGION="${arg#*=}" ;;
    --prefix=*) PREFIX="${arg#*=}" ;;
    --keep-tag=*) KEEP_TAG="${arg#*=}" ;;
    --min-age-minutes=*) MIN_AGE_MINUTES="${arg#*=}" ;;
    --apply) APPLY="true" ;;
    --dry-run) APPLY="false" ;;
    *) echo "Argumento desconocido: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$SERVICE" ] || [ -z "$PROJECT" ] || [ -z "$REGION" ]; then
  echo "Faltan argumentos obligatorios: --service, --project, --region" >&2
  exit 2
fi

if ! [[ "$MIN_AGE_MINUTES" =~ ^[0-9]+$ ]]; then
  echo "--min-age-minutes debe ser un entero, recibido: $MIN_AGE_MINUTES" >&2
  exit 2
fi

echo "Barrido de tags '${PREFIX}*' huérfanos en '$SERVICE' ($PROJECT / $REGION)"
[ -n "$KEEP_TAG" ] && echo "  Se conserva siempre: $KEEP_TAG"
echo "  Edad mínima de la revisión: ${MIN_AGE_MINUTES} min · modo: $([ "$APPLY" = "true" ] && echo APLICAR || echo "dry-run (no toca nada)")"

# Un servicio que aún no existe no es un error: es el primer despliegue.
SERVICE_JSON=$(gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT" \
  --format=json 2>/dev/null) || SERVICE_JSON=''

if [ -z "$SERVICE_JSON" ]; then
  echo "  El servicio no existe todavía (o no es legible). Nada que barrer."
  exit 0
fi

# `spec.traffic` es la INTENCIÓN declarada — es lo que hay que limpiar.
# `status.traffic` es lo que el plano de control ya materializó y puede ir
# por detrás durante un despliegue en curso.
CANDIDATES=$(jq -r --arg prefix "$PREFIX" --arg keep "$KEEP_TAG" '
  [ .spec.traffic[]?
    | select(.tag != null)
    | select(.tag | startswith($prefix))
    | select(.tag != $keep)
    | select((.percent // 0) == 0)
    | { tag: .tag, revision: (.revisionName // "") }
  ] | .[] | "\(.tag)\t\(.revision)"
' <<< "$SERVICE_JSON" | tr -d '\r')

# Un tag con prefijo que SÍ sirve tráfico se reporta pero no se toca: o hay un
# canary en vuelo, o un run abortado dejó el reparto partido. Retirarlo movería
# tráfico de producción, que es justo lo que este script no debe hacer nunca.
SERVING=$(jq -r --arg prefix "$PREFIX" '
  [ .spec.traffic[]?
    | select(.tag != null)
    | select(.tag | startswith($prefix))
    | select((.percent // 0) > 0)
    | "\(.tag) (\(.percent)%)"
  ] | join(", ")
' <<< "$SERVICE_JSON" | tr -d '\r')

if [ -n "$SERVING" ]; then
  echo "  ⏭  Sirviendo tráfico, NO se tocan: $SERVING"
fi

if [ -z "$CANDIDATES" ]; then
  echo "  No hay tags huérfanos. Nada que hacer."
  exit 0
fi

# Edades de las revisiones candidatas, en UNA sola llamada y filtrando por
# nombre en el servidor.
#
# Aquí hay dos trampas que ya se pagaron:
#   · `revisions describe` por cada tag tarda ~7s; con 17 huérfanos se pasa de
#     los dos minutos y en CI eso es tiempo tirado.
#   · `revisions list` SIN filtro devuelve la lista entera ordenada por fecha
#     descendente y la trunca: en genie-api (922 revisiones vivas) volvió
#     cortada justo después de la más reciente de las huérfanas, así que todas
#     las demás aparecían "sin timestamp" y se conservaban por prudencia. El
#     barrido se quedaba en 1 de 11 tags.
# El filtro por nombre devuelve solo las que interesan y es determinista.
REVISION_NAMES=$(cut -f2 <<< "$CANDIDATES" | grep -v '^$' | sort -u | tr '\n' ' ')

REVISION_AGES=''
if [ -n "${REVISION_NAMES// /}" ]; then
  REVISION_AGES=$(gcloud run revisions list \
    --service="$SERVICE" \
    --region="$REGION" \
    --project="$PROJECT" \
    --filter="metadata.name=( $REVISION_NAMES )" \
    --format='value(metadata.name,metadata.creationTimestamp)' 2>/dev/null | tr -d '\r') || REVISION_AGES=''
fi

NOW_EPOCH=$(date -u +%s)
MIN_AGE_SECONDS=$((MIN_AGE_MINUTES * 60))

TO_REMOVE=()
while IFS=$'\t' read -r TAG REVISION; do
  [ -z "$TAG" ] && continue

  CREATED=$(awk -v r="$REVISION" '$1 == r { print $2; exit }' <<< "$REVISION_AGES")

  if [ -z "$CREATED" ]; then
    # Sin timestamp no se puede acreditar la edad. Se conserva por prudencia:
    # más vale un huérfano de más que retirar el canary de un run en vuelo.
    echo "  ⏭  $TAG → $REVISION · sin timestamp de creación, se conserva"
    continue
  fi

  CREATED_EPOCH=$(date -u -d "$CREATED" +%s 2>/dev/null) || CREATED_EPOCH=""
  if [ -z "$CREATED_EPOCH" ]; then
    echo "  ⏭  $TAG → $REVISION · timestamp ilegible ($CREATED), se conserva"
    continue
  fi

  AGE=$((NOW_EPOCH - CREATED_EPOCH))
  if [ "$AGE" -lt "$MIN_AGE_SECONDS" ]; then
    echo "  ⏭  $TAG → $REVISION · $((AGE / 60)) min de vida (< $MIN_AGE_MINUTES), posible despliegue en vuelo"
    continue
  fi

  echo "  🧹 $TAG → $REVISION · $((AGE / 86400))d $(((AGE % 86400) / 3600))h · 0% de tráfico"
  TO_REMOVE+=("$TAG")
done <<< "$CANDIDATES"

if [ ${#TO_REMOVE[@]} -eq 0 ]; then
  echo "  Ningún candidato supera los filtros de seguridad. Nada que hacer."
  exit 0
fi

REMOVE_LIST=$(IFS=,; echo "${TO_REMOVE[*]}")

if [ "$APPLY" != "true" ]; then
  echo ""
  echo "  DRY-RUN. Para aplicarlo, repite el comando con --apply."
  echo "  Se retirarían ${#TO_REMOVE[@]} tag(s): $REMOVE_LIST"
  exit 0
fi

# Una sola llamada con todos los tags: una escritura del plano de control en vez
# de N, y por tanto un solo strip del binding IAM en vez de N.
echo ""
echo "  Retirando ${#TO_REMOVE[@]} tag(s) en una sola llamada..."
gcloud run services update-traffic "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT" \
  --remove-tags="$REMOVE_LIST" \
  --quiet || echo "  update-traffic devolvió error; se verifica el estado igualmente"

VERIFY_JSON=$(gcloud run services describe "$SERVICE" \
  --region="$REGION" \
  --project="$PROJECT" \
  --format=json 2>/dev/null) || VERIFY_JSON=''

if [ -z "$VERIFY_JSON" ]; then
  echo "  ⚠️  No se pudo releer el servicio para verificar el barrido."
  exit 1
fi

REMAINING=$(jq -r --arg list "$REMOVE_LIST" '
  ($list | split(",")) as $wanted
  | [ .spec.traffic[]? | select(.tag != null) | select(.tag as $t | $wanted | index($t)) | .tag ]
  | join(", ")
' <<< "$VERIFY_JSON" | tr -d '\r')

if [ -n "$REMAINING" ]; then
  echo "  ⚠️  Siguen presentes tras el barrido: $REMAINING"
  exit 1
fi

echo "  ✅ Verificado: los ${#TO_REMOVE[@]} tag(s) ya no están en el servicio."
echo ""
echo "  Recordatorio: si '$SERVICE' es PÚBLICO, vuelve a atar el binding —"
echo "  --remove-tags se lo lleva por delante:"
echo "    gcloud run services add-iam-policy-binding $SERVICE \\"
echo "      --region=$REGION --project=$PROJECT \\"
echo "      --member=allUsers --role=roles/run.invoker"
exit 0

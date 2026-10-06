# Trivy: instalación fiable y adopción sin rebajar el gate

Corte observado inicial: 6 de octubre de 2026, 00:32 UTC. La preparación se
autorizó solo como borrador revisado. Posteriormente JP autorizó integrar lo
que esté listo (5 de octubre, hora Bogotá): exige revisión final y checks del
SHA exacto. No autoriza bypass ni cambios de runners, permisos o protección de ramas.

## Diagnóstico y alcance

Mastra #540, fuente `611220893d7b49c1ef1b7e33da5a93cab9a8c1d8`, falló en
`Install Trivy`, no en el análisis: run `37390794576`, job `112035116226`,
salida 28; cuatro análisis posteriores quedaron omitidos. La causa subyacente
del transporte/host no está atribuida. No es prueba de una vulnerabilidad ni
de una auditoría limpia. La muestra acotada de cinco runs de seguridad de
Mastra tiene dos fallos de instalación y tres instalaciones exitosas; no es
un censo global de disponibilidad.

El caller fija `4af4f32a1c3185a0e2f8212d780863cab1bd0f04`, cuyo setup-trivy
descarga con un intento y caché deshabilitada. La rama compartida `v1` ya tiene
reintentos y checksum desde `5995611`; mejorarlos allí no actualiza ese pin.
Base de esta reparación: `e03fc5127c4b8e1e0af22ddc20bf15a34f52eb60`.

## Contrato de la reparación compartida

- Trivy continúa fijado a `v0.74.0`. Archivo verificado con SHA-256 de la release
  por HTTPS y versión ejecutable exacta antes de publicar PATH. Esto no equivale
  a una firma criptográfica independiente ni a un checksum anclado fuera de GitHub.
- Las dos descargas tienen cinco reintentos, presupuesto de reintento de 240 s
  y máximo 60 s por transferencia. curl puede iniciar un último intento antes
  del límite: cada petición consume hasta aproximadamente 300 s; el paso tiene
  un límite adicional de 12 minutos dentro del job de 30 minutos.
- Directorios privados y exclusivos mediante mktemp. No se confía en un
  binario preexistente ni se añade una caché persistente sin raíz de confianza.
  La caché de datos de vulnerabilidades no se cambia ni se congela.
- Timeout y descarga no disponible se clasifican como fallos de instalación,
  con categoría y código numérico; no se publica texto crudo del proveedor.
- Cualquier descarga, integridad o versión fallida sigue bloqueando el job.
  No se modifica la selección de severidades, los scanners ni su gate final.

## Guarda mecánica y límites de la prueba

`scripts/test-trivy-installer.mjs` extrae y ejecuta el bloque Bash real del
workflow: tar, SHA-256, comprobación ejecutable y escritura de PATH. Solo se
sustituye el transporte de GitHub por un servidor efímero loopback y curl real;
el wrapper acelera los límites temporales y permite HTTP únicamente en la
fixture. No se descarga ni ejecuta Trivy real, no se instalan dependencias y
no se contacta con proveedores externos.

La suite cubre éxito, descarga transitoria, agotamiento, timeout, cuatro
checksums inválidos, versión incorrecta, runner no soportado y symlink de
ejecución anterior. Las mutaciones quitan reintentos, verificación de versión
o checksum y ejercitan los casos que detectan cada pérdida. La suite está
cableada en `validate-workflow-contracts.yml`. La ejecución local es Linux/X64;
macOS, Windows y ARM64 reales siguen sin verificarse.

RED observado antes de corregir: la versión incorrecta fue aceptada y el
directorio determinista permitía sobrescribir una fixture anterior mediante
symlink. Ambos casos pasan tras la reparación; no se afirma que causaran el
timeout histórico.

## Barrido de consumidores y adopción

Lectura REST de la rama por defecto y caller en el mismo corte:

| Repo                       | SHA observado                              | Referencia compartida                      | Resultado                                             |
| -------------------------- | ------------------------------------------ | ------------------------------------------ | ----------------------------------------------------- |
| mastra-nutritional-plan-ai | `dadef1706a1da521110b18fb9887f7150e83b627` | `4af4f32a1c3185a0e2f8212d780863cab1bd0f04` | Instalador antiguo; adopción pendiente.               |
| nutritional-engine-api     | `ebc71804253e4cd6a36f0896ec85c484dad1f82b` | `v1`                                       | Hereda la rama; no prueba de ejecución del candidato. |
| gundo-ecommerce-ui         | `3f7442be053629c06b33c6cb187ff0dd222c94d9` | `v1`                                       | Hereda la rama; no prueba de ejecución del candidato. |
| genie-api                  | `57d9b781d4360ed47ced2f828770a6cd5d803973` | `v1`                                       | Hereda la rama; no prueba de ejecución del candidato. |

Los cuatro callers declaran `vulnerability-severity: HIGH,CRITICAL`; ninguno
declara el nuevo input de PR. En v1 ese input tiene un default separado
CRITICAL. No se debe inferir HIGH a partir del otro input ni rebajar un gate
al migrar. En Mastra, conserva expresamente ambos:

```yaml
with:
  runner-label: gundo-local
  vulnerability-severity: "HIGH,CRITICAL"
  pull-request-vulnerability-severity: "HIGH,CRITICAL"
```

El manifiesto Trinity Mastra contiene el blob del caller antiguo
(`dbdfb07b98b20ff803c90e3fb26e9dbc92a6f32c`). Su comparación de auto-integridad
usa `github.workflow_sha`, pero eso no acredita por sí mismo una raíz externa
independiente del PR. Lectura REST posterior (00:54 UTC): el único ruleset
visible con includes_parents=true, CI gate20203979/master, exige lint / lint,
Typecheck y Test; no muestra required workflow ni Trinity requerido. La
protección clásica responde404 Branch not protected. Es un riesgo de
gobernanza preexistente, no un motivo para autoaprobar la adopción. Un verde
del workflow propuesto no cierra el riesgo. El dueño debe establecer y
demostrar un procedimiento confiable antes de integrar el cambio del manifiesto.
No se modifican rulesets para desbloquearlo.

La propuesta Mastra #542 conserva ambos umbrales y solo cambia el blob esperado
del caller; sigue en borrador. Su guarda prueba coherencia/rechazo con confianza
remota simulada, no certifica la raíz real ni autoriza producción.

Secuencia de adopción pendiente:

1. Revisar este borrador y todos sus checks exactos antes de la integración
   autorizada por JP: los callers `@v1` heredan ese cambio al ejecutar.
2. Congelar un SHA compartido revisado y preparar el delta Mastra de pin y
   ambos umbrales. Actualizar el manifiesto por el procedimiento confiable de
   Trinity establecido y demostrado por su dueño, sin autoaprobación, bypass
   ni cambios de IAM/runners en esta reparación.
3. Reconsultar el SHA de cada consumidor. Validar el workflow realmente
   ejecutado, instalación y scanners terminales; instalación verde sola no es
   seguridad verde. No repetir ciegamente runs anteriores ni heredar checks.
4. Registrar la evidencia de adopción por repo. Esta entrega no certifica
   producción ni elimina la dependencia externa de las releases de GitHub.

## Feedback-loop

- Radar: existía la mejora central, pero faltaba verificar qué pin ejecutaba
  cada consumidor y someter el instalador real a fallos adversos.
- Sistémico: pin antiguo Mastra; tres callers flotantes v1 y cuatro inputs de
  PR implícitos. Riesgos registrados en TECH_DEBT, no reparados en otros repos.
- Guarda: pruebas offline y mutaciones del código inline real, cableadas en CI.
- Verificación viva/adopción: pendiente de runs reales exactos y de la
  gobernanza externa de Mastra, no cerrada por autorizar merges de items listos.
- Memoria: no escrita; requiere petición explícita de JP.

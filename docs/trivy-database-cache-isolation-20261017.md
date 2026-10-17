# Aislamiento de la base de vulnerabilidades de Trivy

El run de seguridad de NE `38998325452`, head `21451d4a`, falló al refrescar la base: `unable to get metadata: json decode error: EOF`. El análisis de dependencias no terminó; el fallo no acredita una vulnerabilidad ni un resultado limpio. La incidencia automática es NE #291.

La fuente compartida `v1` usaba `${RUNNER_TOOL_CACHE}/gundo-trivy-cache`, mutable y compartida entre runners. La reparación crea un directorio exclusivo con `mktemp` bajo `RUNNER_TEMP` para cada ejecución del paso y lo elimina al terminar, incluso si Trivy rechaza el análisis. No reutiliza metadatos interrumpidos, no borra la caché compartida ni interrumpe trabajos ajenos.

Se conserva Trivy v0.74.0 verificado, todos los scanners, dependencias de desarrollo, severidades, `ignore-unfixed`, salida 1 ante hallazgos y gate final. Cada análisis descarga su base vigente: se acepta ese coste de red y tiempo a cambio de evitar escritores concurrentes sobre metadatos comunes. No se añade una omisión ni un retry que oculte hallazgos.

`scripts/test-trivy-cache-isolation.mjs` ejecuta el Bash real con dos procesos independientes y roots de runner compartidos. La frontera externa Trivy se sustituye por una fixture que detecta escritores concurrentes con filesystem y barreras; no depende de temporizadores para su orden. Cubre IDs iguales/distintos, salida no cero y limpieza, metadatos compartidos corruptos que deben quedar intactos y una mutación que restaura la caché compartida. Rojo previo: 4 fallos/1 aprobado. La prueba queda cableada en CI.

La reproducción demuestra colisión del diseño anterior bajo concurrencia; no prueba cuál proceso produjo el EOF histórico. Verde: 5/5 casos nuevos, 20/20 regresiones del instalador y despliegue, validador y sus cuatro mutaciones aprobados en Linux/X64 local. No acredita escaneo real ni otros sistemas operativos.

Tras CI y revisión del head, publicar en `v1` y repetir **todos los jobs** del workflow de seguridad de NE sobre su mismo head. GitHub conserva el SHA original del reusable al repetir solo fallos o un job; al repetir todos resuelve la referencia de rama. [Comportamiento oficial de reejecuciones](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#behavior-of-reusable-workflows-when-re-running-jobs). Contrastar en los logs el SHA del reusable realmente ejecutado.

Solo un escaneo real aprobado cierra el incidente de esa ejecución. No hay cambio de permisos, runners, protecciones ni datos de negocio.

# Ciclo de vida de repositorios y proyectos

Un repositorio antiguo no se mantiene indefinidamente para que sea seguro. Se hace una ultima clausura de seguridad, se desconecta su runtime y despues se archiva como referencia.

## Estados

| Estado | Regla |
|---|---|
| `ACTIVE` | Producto, libreria, pipeline o tracker vigente. Recibe mantenimiento normal, Renovate y escaneo de seguridad. |
| `SUNSET` | Sigue abierto solo para seguridad critica, cumplimiento, migracion, exportacion, borrado y apagado. No recibe funcionalidades ni modernizacion ordinaria. |
| `ARCHIVE_READY` | No tiene runtime, credenciales, datos, consumidores ni obligaciones abiertas. Puede archivarse tras cerrar PR e issues residuales. |

GitHub archivado es el estado final y de solo lectura. No es un sustituto de revocar claves, borrar datos personales o apagar infraestructura.

## Gates antes de archivar

Todos deben ser verdaderos:

1. No hay trafico o cobros que dependan del proyecto.
2. Dominios, hosting, Cloud Run, Functions, jobs, schedulers, triggers y webhooks estan retirados o redirigidos.
3. Claves de servicio, OAuth, tokens y webhooks estan revocados, no solo borrados del repositorio.
4. No quedan datos personales, de salud o financieros fuera de su politica de conservacion.
5. No hay alertas criticas abiertas ni secretos actuales en codigo o historial.
6. Los consumidores y paquetes publicados fueron migrados o retirados.
7. README y descripcion indican fecha, sustituto y condicion para reutilizar el codigo.
8. Issues y PR se cerraron o trasladaron; existe copia de referencia si la retencion la exige.

Si el proyecto se reutiliza, se desarchiva y pasa por escaneo, actualizacion y verificacion de runtime completos antes de desplegar.

## Dry-run medido el 27 de agosto de 2026

GitHub devolvio 48 repositorios privados sin archivar y 34 archivados entre `Gundo-Health-and-Food` y `jplannnou`.

### Archivo de GitHub listo tras cierre administrativo

- `Gundo-Health-and-Food/vtex`: solo contiene `.gitignore`; sin codigo, issues, consumidores ni runtime detectado. Cerrar PR #4 antes de archivar.
- `Gundo-Health-and-Food/gundo-client-analytics`: solo contiene `.gitignore` y el caller de seguridad; sin codigo, issues, PR, consumidores ni runtime detectado.

### Runtime listo para retirada tras confirmacion destructiva

- `gemini-completion-api`: cero solicitudes Cloud Run observadas en 30 dias; quedan el servicio y el trigger de Cloud Build.
- `app-fitness-demo`: `fitness-demo-main` y `general-demo-main` no registraron solicitudes en 30 dias; sus repos ya estan archivados.
- Staging y canaries sin trafico observado: `genie-ui-staging`, `genie-ui-canary-test`, `gundo-ecommerce-ui-lab`, `gundo-ecommerce-ui-staging`, `gundo-ecommerce-ui-canary-test` y `gundo-admin-fitness-api-canary-test`.
- `internal-dashboard-ui-staging`: 998 solicitudes observadas, todas fallidas; parece trafico automatizado contra una superficie rota.
- `gundo-website-ui` antiguo: 5.427 solicitudes observadas, ninguna exitosa; el repositorio ya esta archivado y el dominio canonico usa `gundo-plataform-ui`.

### SUNSET con gates abiertos

- Uvesco: tres repos; falta fusionar la limpieza, revocar dos claves historicas en `uvesco-app`, resolver las alertas criticas de UI y verificar hosting/dominios.
- DIA: UI con 3.591 solicitudes observadas y cero exitosas; API con una sola solicitud automatizada. Confirmar obligaciones del retailer y datos antes de apagar.
- AndresFit: 6.861 solicitudes observadas y cero exitosas; el proyecto conserva personas legacy y requiere aviso/borrado antes de retirarlo.
- Beat Boxing: hubo respuestas exitosas recientes en autenticacion y API. No se apaga hasta identificar si corresponden a personas, webhooks o pruebas.
- Ametller UI: partner vigente; validar uso contractual y del portal antes de moverlo a `ARCHIVE_READY`.
- `genie-ui`: recibe trafico exitoso y sigue siendo el Data Center legacy. Su archivo depende de internalizar los recorridos pendientes.
- `gundo-admin-fitness-api` y UI: siguen sirviendo el canal fitness con cobros. Se cierran con la migracion white-label, no de forma aislada.
- Gundo Vida: solo migracion, seguridad critica, exportacion, borrado y redirect final.
- Doce proyectos de clubes legacy: aviso cofirmado, 30 dias, exportacion/borrado y apagado por proyecto. Club C no se apaga; se migra.

## Auditoria

Ejecuta desde un equipo con `gh` autenticado:

```powershell
powershell -NoProfile -File scripts/audit-repository-lifecycle.ps1
```

La auditoria falla si aparece un repositorio privado sin clasificar, si el manifiesto contiene duplicados o estados invalidos, o si un repositorio ya archivado sigue en el inventario operativo. `-NoLive` valida solo el contrato del manifiesto.

# 40 — KPI y analytics: medir sin descargar la base de datos

## Concepto

Un dashboard de calidad parece "solo lectura", pero es la parte del producto donde
más fácil es mentir sin querer. Un KPI sin ventana temporal, sin denominador
explícito o que mezcla organizaciones no es un número: es una opinión. Este
capítulo explica cómo S2-F9 calcula cada indicador **en el backend**, en SQL
agregado, bajo RLS, y cómo el frontend se limita a dibujar lo que recibe.

Código de referencia:

- `packages/shared/src/analytics/analytics.contracts.ts` — ventanas, buckets y
  fórmulas puras (`executionKpis`, `coverageKpis`, `compare`).
- `apps/api/src/modules/dashboard/analytics.repository.ts` — SQL agregado.
- `apps/api/src/modules/dashboard/analytics.service.ts` — autorización y armado.
- `apps/api/src/modules/dashboard/analytics.controller.ts` — seis endpoints.
- `apps/web/src/pages/DashboardPage.tsx` y `components/analytics/charts.tsx`.

## Qué problema resuelve

El dashboard del MVP contaba estados por request y la cobertura cargaba todos los
ids de requisitos en memoria para luego agrupar enlaces. Con 50 000 requisitos eso
es una lista de 50 000 parámetros. El objetivo de esta fase es doble:

1. **Ningún endpoint transfiere filas para contarlas.** PostgreSQL agrupa; Node
   solo aplica fórmulas sobre conteos.
2. **Cada número tiene contrato.** Ventana `[from, to)`, bucket, momento de
   cálculo y una fórmula escrita una sola vez en `packages/shared`.

## La ventana temporal

```ts
GET /api/v1/projects/:projectId/dashboard/summary?from=2026-09-01&to=2026-10-01&bucket=week
```

- Sin parámetros: últimos 30 días.
- Solo `from`: `to = from + 30 días`. Solo `to`: `from = to − 30 días`.
- Máximo 366 días; `from < to` o 400 de validación.
- Bucket por defecto según la longitud: ≤ 31 días → `day`, ≤ 186 → `week`,
  si no `month`. Buckets en UTC; la semana empieza el lunes.

Cada respuesta incluye `period` y `computedAt`. La comparación con el periodo
anterior usa una ventana **de la misma longitud** inmediatamente previa
(`previousPeriod`), y `delta` se expresa en puntos.

## Las fórmulas (y la discusión sobre `untested`)

```text
planned   = untested + passed + failed + blocked + skipped
executed  = planned − untested
verdicts  = passed + failed + blocked

passRate    = passed  / verdicts
failedRate  = failed  / verdicts
blockedRate = blocked / verdicts
skippedRate = skipped / planned
untestedRate= untested/ planned
progress    = executed / planned
```

¿Por qué el pass rate no divide por `planned`? Porque mezclaría dos preguntas:
"¿qué tal va lo que probamos?" y "¿cuánto llevamos probado?". Con `planned` como
denominador, un run al 10 % de avance tendría un pass rate máximo del 10 %, y el
equipo leería "todo falla" cuando en realidad "casi nada se ha ejecutado". Por eso
hay dos KPI separados: **pass rate** (calidad de lo ejecutado con veredicto) y
**progress** (avance). `skipped` no es veredicto: no dice nada de la calidad,
así que se mide sobre `planned`.

Denominador cero → `null`, nunca 0. La UI muestra "—". Un 0 % falso es peor que
un hueco honesto. La excepción es `progress` de un plan no vacío sin ejecutar:
ahí el 0 % es real.

**Cobertura:** requisitos activos (no borrados, no `obsolete`) con al menos un
enlace `requirement → test_case`, entre requisitos activos. Es cobertura de
enlace, no de verificación (deuda 17).

**Defectos abiertos:** todo estado salvo `closed` y `rejected`. **Críticos:**
abiertos con severidad `blocker` o `critical`. **Defectos por caso ejecutado:**
defectos cuyo `testRunId` es un run en alcance / casos ejecutados.

## Qué es un "run en alcance"

Un run no borrado ni abortado que estaba vivo en la ventana:
`createdAt < to` y (`completedAt` nulo o `completedAt >= from`). La distribución
actual usa `TestRunCase.latestStatus`: una fila por caso, gana el último
resultado. Las tendencias, en cambio, cuentan **todos** los resultados por
`executedAt` en cada bucket. Son dos preguntas distintas ("¿cómo está?" y "¿qué
pasó cada día?") y por eso tienen dos fuentes.

## SQL agregado bajo RLS

El patrón se repite en todas las consultas del repositorio:

```sql
SELECT r."projectId", c."latestStatus", COUNT(*)::int
FROM test_run_cases c
JOIN test_runs r ON r.id = c."testRunId"
WHERE c."organizationId" = $org
  AND r."organizationId" = $org
  AND r."projectId" = ANY($authorizedProjects)
  AND r."deletedAt" IS NULL AND r.status <> 'aborted'
GROUP BY r."projectId", c."latestStatus";
```

Tres capas de aislamiento, a propósito redundantes:

1. Cada tabla de cada sentencia filtra por `organizationId`.
2. Todo corre dentro de `read()`, una transacción que fija
   `app.current_organization`, así que las políticas RLS aplican aunque alguien
   olvide el punto 1.
3. La lista de proyectos es explícita y ya autorizada por el servicio.

La cobertura usa `EXISTS` en vez de traer ids:

```sql
SELECT COUNT(*) FILTER (WHERE EXISTS (
  SELECT 1 FROM traceability_links l
  WHERE l."organizationId" = $org AND l."sourceType" = 'requirement'
    AND l."targetType" = 'test_case' AND l."sourceId" = q.id))
FROM requirements q WHERE ...
```

Las tendencias reconstruyen series acumuladas (defectos abiertos, cobertura) con
una **línea base** antes de `from` más incrementos por bucket; el servicio suma
en `trendPoints()`. Un requisito cuenta como cubierto desde el bucket de su
**primer** enlace, no desde su creación — un test de integración detectó
justamente ese error durante la fase.

## Autorización: proyecto y organización

Las rutas de proyecto usan `@ProjectScoped()` + `@RequirePermission('analytics.read')`
y el servicio llama a `assertRouteAccess(projectId)`: un revoke de
`analytics.read` en ese proyecto devuelve 403.

La vista de organización no puede llamar a `assertRouteAccess` por cada proyecto
(sería N+1 y lanzaría en el primero sin permiso). En su lugar,
`ProjectAccessService.projectsAllowing('analytics.read', ids)` resuelve en **dos
lecturas** (grants y overrides del usuario) qué proyectos puede analizar, con la
misma regla de S2-F8: owner todo; rol de proyecto o de organización; override
`grant`/`revoke` gana. Los proyectos excluidos no aparecen en totales, rankings,
tendencias ni actividad.

## El frontend: dibujar, no calcular

`DashboardPage` pide los cinco endpoints del proyecto en paralelo con React Query
(clave `['analytics', projectId, window, parte]`) o el de organización. No hay
librería de gráficos: barras HTML con el valor impreso, una barra apilada con su
tabla de leyenda, y líneas SVG con patrones de trazo distintos y un `<details>`
con la tabla de datos. El color nunca es la única señal: cada estado lleva texto,
cada serie su etiqueta y su tipo de línea.

## Cómo se prueba

- **Unitarios (`packages/shared`)**: ventanas, buckets, `executionKpis` con
  denominadores cero, cobertura, comparación.
- **Integración (`apps/api/test/analytics.int-spec.ts`)**: proyecto vacío, cada
  tasa, último estado sustituye al anterior, runs abortados fuera, cobertura con
  obsoletos, defectos por severidad/prioridad/estado, MTTR, tendencias diarias,
  organización con rankings, aislamiento entre organizaciones y proyectos,
  revoke de `analytics.read`, anónimo.
- **RLS runtime (`rls-runtime.int-spec.ts`)**: la API arranca como `qaflow_app`
  y otra organización no ve ni un agregado.
- **E2E (`apps/web/e2e/analytics.e2e.spec.ts`)**: un pass y un fallo reales y la
  lectura de los KPI en ambos dashboards.

## Preguntas de repaso

1. ¿Por qué `passRate` y `progress` tienen denominadores distintos?
2. ¿Qué pasaría si la vista de organización llamara a `assertRouteAccess` en un bucle?
3. ¿Por qué filtrar por `organizationId` si RLS ya lo hace?
4. ¿Qué diferencia hay entre la distribución actual y la tendencia de resultados?

## Ejercicios

1. Añade un parámetro `tz` (zona IANA validada) y úsalo en `date_trunc`.
2. Añade una serie `verified` (requisito con caso enlazado cuyo último resultado
   es `passed` y sin defecto abierto) y su test de integración.
3. Mide con `EXPLAIN ANALYZE` la consulta de tendencias con 100 000 resultados y
   decide si necesita un índice `(organizationId, executedAt)`.

## Qué diría en una entrevista

"Los KPI se calculan en PostgreSQL con `GROUP BY` y `EXISTS`, dentro de una
transacción con el tenant fijado para RLS; Node solo aplica fórmulas puras
compartidas con el frontend. Cada respuesta lleva su ventana y su momento de
cálculo, y los denominadores cero devuelven `null`. La vista organizacional
resuelve permisos de todos los proyectos en dos lecturas y agrega solo los
autorizados."

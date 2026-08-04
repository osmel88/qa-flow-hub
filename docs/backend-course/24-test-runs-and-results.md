# 24 — Ejecuciones y resultados

## Concepto

Un *test run* es la ejecución de un conjunto de casos en un momento y un
entorno concretos. Es lo que convierte un catálogo de pruebas en un informe:
«en la release 1.0, sobre staging, 84 casos pasaron y 6 fallaron».

```
TestRun ──< TestRunCase ──< TestResult
              (snapshot)     (append-only)
```

## Qué problema resuelve

Los dos problemas son de **integridad histórica**, y ninguno se ve hasta meses
después:

1. Alguien edita un caso de prueba. Si la ejecución apunta al caso vivo, el
   informe de marzo pasa a describir algo que en marzo no existía.
2. Alguien vuelve a probar un caso que había fallado. Si el resultado se
   sobrescribe, desaparece la prueba de que hubo un fallo — justo el dato que
   justifica el trabajo del equipo de QA.

## Archivos reales

```
packages/shared/src/test-runs/test-run.contracts.ts
apps/api/src/modules/test-runs/test-runs.repository.ts
apps/api/src/modules/test-runs/test-runs.service.ts
apps/api/src/modules/test-runs/test-runs.controller.ts
apps/api/test/test-runs.int-spec.ts        26 tests
```

## Endpoints

```
POST   /api/v1/test-runs                          crea, opcionalmente con casos
GET    /api/v1/test-runs?projectId=&status=&milestone=&search=
GET    /api/v1/test-runs/:id
PATCH  /api/v1/test-runs/:id
POST   /api/v1/test-runs/:id/start
POST   /api/v1/test-runs/:id/complete
POST   /api/v1/test-runs/:id/abort
DELETE /api/v1/test-runs/:id

POST   /api/v1/test-runs/:id/cases                añade más casos
GET    /api/v1/test-runs/:id/cases?status=&assignedToId=
DELETE /api/v1/test-runs/:id/cases/:runCaseId
POST   /api/v1/test-runs/:id/assignments          asignación masiva

POST   /api/v1/test-runs/:id/cases/:runCaseId/results
GET    /api/v1/test-runs/:id/cases/:runCaseId/results
```

## La decisión central: el snapshot

`TestRunCase.caseSnapshot` guarda el título, las precondiciones, el resultado
esperado y los pasos **tal como estaban al incluir el caso**, más
`caseVersion`.

```ts
function snapshotOf(testCase: TestCase & { steps: TestStep[] }): RunCaseSnapshot {
  return {
    key: testCase.key,
    title: testCase.title,
    preconditions: testCase.preconditions,
    expectedResult: testCase.expectedResult,
    priority: testCase.priority,
    type: testCase.type,
    steps: testCase.steps.map((step) => ({ ... })),
  };
}
```

Es duplicación de datos, y es deliberada. Las alternativas son peores:

| Alternativa | Por qué no |
| --- | --- |
| Apuntar al caso vivo | El informe cambia retroactivamente |
| Versionar el caso entero y apuntar a la versión | Correcto, pero exige tabla de versiones, resolución en cada lectura y una migración; es adonde iremos si hace falta editar el histórico |
| Prohibir editar un caso que esté en un run | Convierte el catálogo en inmutable, que es inaceptable para el usuario |

La regla que se deriva: **el `testCaseId` es para trazabilidad, el snapshot es
para leer**. Ninguna pantalla de ejecución consulta el caso vivo.

Está probado de forma directa: el test incluye un caso en un run, luego le
reescribe los pasos y le cambia el título, y comprueba que la ejecución sigue
mostrando el texto original.

## Los resultados son append-only

`recordResult` solo hace `INSERT`. No hay `PATCH /results/:id` ni `DELETE`, y
esa ausencia es la garantía.

Lo que sí se actualiza es una **proyección**: `TestRunCase.latestStatus`. Listar
un run con 500 casos y su estado actual, sin la proyección, sería una subconsulta
correlacionada por fila. Con ella es una lectura de columna y un índice
`(organizationId, testRunId, latestStatus)`.

La proyección es derivable —siempre es el resultado más reciente por
`executedAt`—, así que es reconstruible si alguna vez se descuadra. Se escribe
en la misma transacción que el resultado, que es lo que impide que se descuadre.

El progreso tampoco se guarda: se calcula con **un `groupBy`**, no con cinco
`count`.

```ts
const rows = await this.prisma.testRunCase.groupBy({
  by: ['latestStatus'],
  where: this.scope({ testRunId }),
  _count: { _all: true },
});
```

## Los cinco estados

`untested`, `passed`, `failed`, `blocked`, `skipped`.

Dos matices que un producto de QA no puede confundir:

- **`blocked` no es `failed`.** Una causa externa impidió verificar (el entorno
  se cayó, faltaba un dato). El caso no ha fallado: no se sabe. Contarlo como
  fallo infla la tasa de defectos y hace que el equipo deje de mirar el informe.
- **`untested` no se puede registrar.** Es la ausencia de resultado, no un
  resultado. Por eso el contrato tiene dos enums:

```ts
export const TEST_RESULT_STATUSES = ['untested', 'passed', 'failed', 'blocked', 'skipped'];
export const RECORDABLE_RESULT_STATUSES = ['passed', 'failed', 'blocked', 'skipped'];
```

El tipo hace imposible el estado imposible; no hace falta una comprobación en
tiempo de ejecución.

## El ciclo de vida del run

```
planned ──> in_progress ──> completed
   └──────────────┴────────> aborted
```

`completed` y `aborted` son **terminales**. Un run cerrado es un informe, y un
informe que puede cambiar no es un informe. Registrar un resultado en un run
cerrado devuelve 409, igual que renombrarlo.

Y al revés: **el primer resultado arranca el run**. Un run en `planned` con
resultados dentro haría mentir a cualquier dashboard, y nadie se acuerda de
pulsar «empezar».

```ts
if (run.status === 'planned') {
  await this.runs.update(runId, { status: 'in_progress', startedAt: new Date() }, tx);
}
```

## Seleccionar casos: ids o filtro, nunca los dos

```ts
.refine((value) =>
  value.testCaseIds === undefined ||
  (value.suiteId === undefined && value.tag === undefined && ...),
  { message: 'Select cases either by id or by filter, not both' },
)
```

«Estos doce casos» y «todo lo etiquetado como smoke» son intenciones distintas.
Combinarlas en silencio sorprendería a quien escribió la segunda.

Tres reglas más en la selección:

- **Nunca entra un caso archivado**, ni siquiera pedido por id: archivar
  significa «fuera de la planificación».
- **Si se piden ids y no aparecen todos, es un error**, no un subconjunto
  silencioso. Un id que falta es una errata, un caso borrado o un intento de
  arrastrar casos de otro proyecto: las tres merecen un 400.
- **Añadir casos dos veces no los duplica**: `skipDuplicates` sobre el único
  `(testRunId, testCaseId)`, y las posiciones continúan desde el máximo actual.

## Quién puede ejecutar

Los roles de planificación (owner, admin, project manager, qa lead) planifican,
asignan y cierran. Los testers **ejecutan**.

```ts
if (role === 'tester' && runCase.assignedToId !== null && runCase.assignedToId !== userId) {
  throw new ForbiddenError('This case is assigned to somebody else');
}
```

Un tester puede ejecutar lo suyo y lo que no está asignado a nadie, pero no lo
de otro. Los roles superiores pueden registrar por cualquiera, porque en la
práctica un lead cubre a un tester ausente. Los `viewer` no registran nada.

## Borrar un caso del run

Solo si no tiene resultados. Con resultados, el borrado en cascada se llevaría
por delante el registro de lo ejecutado, así que devuelve 409. Quitar algo de un
plan es distinto de borrar la prueba de que se hizo.

## Comandos

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts test/test-runs.int-spec.ts

curl -s -X POST localhost:3000/api/v1/test-runs \
  -H "authorization: Bearer $TOKEN" -H "x-organization-id: $ORG" \
  -H 'content-type: application/json' \
  -d '{"projectId":"'$PROJECT'","name":"Release 1.0","selection":{"tag":"smoke"}}' | jq .progress
```

## Errores comunes

**Apuntar al caso vivo desde la ejecución.** El informe del pasado cambia solo.

**Actualizar el resultado al repetir la prueba.** Se pierde el fallo, que es
justo lo que había que demostrar.

**Guardar el progreso como columnas contadoras.** Se descuadran; el `groupBy` no.

**Tratar `blocked` como `failed`.** Ensucia todas las métricas de calidad.

**Permitir `untested` como resultado registrable.** Un caso «ejecutado como no
ejecutado» no significa nada.

**Dejar que un run cerrado siga recibiendo resultados.** El informe deja de ser
reproducible.

**Ignorar en silencio los ids que no existen.** El usuario cree que ejecutó 20
casos y ejecutó 17.

## Preguntas de repaso

1. ¿Por qué se duplica el caso en `caseSnapshot` en lugar de referenciarlo?
2. ¿Qué se pierde con el snapshot y cuándo habría que pasar a versiones?
3. ¿Por qué `latestStatus` no contradice que los resultados sean append-only?
4. ¿Por qué `untested` está en un enum y no en el otro?
5. ¿Qué diferencia hay entre `blocked` y `failed`, y por qué importa?
6. ¿Por qué el primer resultado cambia el estado del run?
7. ¿Por qué no se puede quitar de un run un caso ya ejecutado?

## Ejercicios

1. Añade `POST /test-runs/:id/clone` que cree un run nuevo con los mismos casos,
   volviendo a tomar el snapshot de la versión actual.
2. Implementa un endpoint de re-run de los fallidos: un run nuevo con solo los
   casos cuyo `latestStatus` sea `failed`.
3. Reconstruye `latestStatus` desde `TestResult` con una sola consulta SQL y
   escribe un test que compruebe que coincide con la columna.
4. Mide el listado de un run con 5 000 casos con y sin la proyección.
5. Añade `elapsedSeconds` agregado por run y por tester, y decide si se calcula
   al vuelo o se materializa.

## Qué diría en una entrevista

> El módulo de ejecución tiene dos invariantes y las dos son históricas. La
> primera: cada caso incluido en un run se congela como snapshot JSON con su
> versión, porque si la ejecución apunta al caso vivo, editar el caso reescribe
> retroactivamente informes pasados. Es duplicación deliberada y el criterio para
> abandonarla sería necesitar editar el histórico, momento en el que pasaría a
> versionar el caso. La segunda: los resultados son append-only, no existe
> endpoint de actualización, y repetir una prueba inserta otra fila; lo que sí
> actualizo es una proyección, latestStatus, en la misma transacción, para poder
> listar 500 casos sin una subconsulta correlacionada. Y separo el enum de
> estados posibles del de estados registrables, porque untested es la ausencia de
> resultado y el tipo debe impedir registrarlo.

## MVP frente a futuro

| Decisión | Ahora | Después |
| --- | --- | --- |
| Snapshot | JSON congelado | Versiones del caso con resolución |
| Progreso | `groupBy` al vuelo | Materializado si el dashboard lo pide |
| Resultados por paso | JSON validado contra el snapshot | Tabla propia si hay que consultarlos |
| Evidencias | Solo metadatos | Almacenamiento real |
| Resultados automatizados | Manual | Ingesta desde CI vía adaptador |
| Asignación | Manual, masiva | Reparto automático por carga |

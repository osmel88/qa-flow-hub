# 25 — Defectos

## Concepto

Un defecto es lo que queda cuando una prueba falla: un problema con severidad,
prioridad, responsable y un ciclo de vida propio. En qa-flow-hub nace
normalmente **desde un resultado fallido**, pero no solo desde ahí.

## Qué problema resuelve

Sin defectos, un run fallido dice «algo va mal» y ahí acaba. El defecto es lo que
convierte un fallo en trabajo asignable y medible, y lo que permite responder
«¿qué está roto ahora mismo en este proyecto?».

## Archivos reales

```
packages/shared/src/defects/defect.contracts.ts
apps/api/src/modules/defects/defects.repository.ts
apps/api/src/modules/defects/defects.service.ts
apps/api/src/modules/defects/defects.controller.ts
apps/api/test/defects.int-spec.ts        21 tests (con trazabilidad)
```

## Endpoints

```
POST   /api/v1/defects
GET    /api/v1/defects?projectId=&status=&severity=&priority=&assigneeId=
                      &testRunId=&open=&search=
GET    /api/v1/defects/:id
PATCH  /api/v1/defects/:id
POST   /api/v1/defects/:id/status
DELETE /api/v1/defects/:id
```

## El origen se deriva, no se acepta

El cliente envía `testResultId`. El servidor deduce de ahí el run y el caso:

```ts
const result = await this.defects.findResultOrigin(input.testResultId);
origin = { testResultId: result.id, testRunId: result.testRunId, testCaseId: result.testCaseId };
```

Si el cliente pudiera enviar los tres, podría crear un defecto que dijera venir
de una ejecución que nunca ocurrió, y toda la trazabilidad quedaría contaminada
con datos plausibles pero falsos. Es la misma clase de problema que el mass
assignment: **no aceptar del cliente lo que el servidor puede calcular**.

Además, solo se admite un origen `failed` o `blocked`. Un defecto que dice venir
de una prueba que pasó es un dato incoherente que después nadie sabe interpretar.

## Severidad y prioridad no son lo mismo

Dos campos, no uno, y confundirlos es el error clásico:

- **Severidad**: cuánto daño hace. Es una propiedad del fallo.
- **Prioridad**: cuándo se arregla. Es una decisión del negocio.

Una errata en el logo de la home es de severidad `trivial` y puede ser de
prioridad `critical` el día antes de una feria. Un crash en una pantalla que usan
tres personas es `blocker` de severidad y `low` de prioridad.

## El ciclo de vida

```
open ──> triaged ──> in_progress ──> resolved ──> closed
  │         │            │                          │
  └─────────┴────────────┴──> rejected              ▼
                                  └──────────> reopened ──> triaged / in_progress
```

`reopened` existe para distinguir **«volvió»** de **«nunca se arregló»**. Sin ese
estado, una regresión y un bug abierto desde hace tres meses son la misma fila y
el informe de calidad pierde su dato más útil.

Las fechas siguen esa misma idea: al reabrir se **limpian** `resolvedAt` y
`closedAt`, para que el tiempo de resolución mida la vida actual del defecto y no
la primera.

```ts
...(input.status === 'reopened' ? { resolvedAt: null, closedAt: null } : {}),
```

La tabla de transiciones vive en el servicio, no en la base de datos. Un enum de
PostgreSQL sabe qué valores existen, no qué secuencias tienen sentido.

## `open=true` no es `status=open`

El filtro más pedido de la lista no es un estado, es una pregunta: *«¿qué sigue
costándonos algo?»*.

```ts
export const OUTSTANDING_STATUSES = ['open', 'triaged', 'in_progress', 'resolved', 'reopened'];
```

`resolved` cuenta como pendiente: el desarrollador dice que lo arregló, pero
hasta que QA lo verifica y lo cierra, el riesgo sigue ahí.

## Roles

Los testers **sí** pueden crear y editar defectos: reportar es su producto
principal, y un flujo donde tienen que pedirle a un lead que registre el bug no
se usa. Los `viewer` no crean nada. Borrar es de owner, admin o project manager,
y es borrado lógico.

## Comandos

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts test/defects.int-spec.ts

curl -s "localhost:3000/api/v1/defects?projectId=$PROJECT&open=true" \
  -H "authorization: Bearer $TOKEN" -H "x-organization-id: $ORG" | jq '.meta.total'
```

## Errores comunes

**Aceptar `testCaseId` y `testRunId` del cliente.** Permite fabricar trazabilidad.

**Un solo campo para severidad y prioridad.** Se pierde la distinción entre daño
técnico y urgencia de negocio.

**No tener `reopened`.** Las regresiones desaparecen de las métricas.

**No limpiar las fechas al reabrir.** El tiempo de resolución queda congelado en
el primer intento.

**Contar `resolved` como cerrado.** Se declara terminado lo que QA todavía no ha
verificado.

**Validar las transiciones solo en el frontend.** La API es el producto.

**Reutilizar el contador de casos para los defectos.** `WEB-C-7` y `WEB-D-7` son
cosas distintas y deben poder coexistir.

## Preguntas de repaso

1. ¿Por qué el servidor deriva el caso y el run en vez de aceptarlos?
2. ¿Por qué solo se puede abrir un defecto desde `failed` o `blocked`?
3. Da un ejemplo de severidad baja con prioridad alta y otro al revés.
4. ¿Qué se pierde si se elimina el estado `reopened`?
5. ¿Por qué `resolved` cuenta como pendiente en `open=true`?
6. ¿Por qué la tabla de transiciones no está en la base de datos?

## Ejercicios

1. Añade comentarios a los defectos, decidiendo si van en tabla propia o en el
   log de auditoría, y justifícalo.
2. Implementa duplicados: marcar un defecto como duplicado de otro y excluirlo de
   los recuentos sin perderlo.
3. Calcula el tiempo medio de resolución por severidad con una sola consulta.
4. Añade una regla que impida cerrar un defecto `blocker` sin un resultado
   posterior en verde del caso que lo originó.
5. Diseña el mapeo de estados hacia Jira y qué pasa cuando los dos lados cambian
   a la vez.

## Qué diría en una entrevista

> Un defecto se abre desde un resultado fallido, y el servidor deriva el caso y
> la ejecución a partir del resultado en lugar de aceptarlos del cliente: si el
> cliente pudiera enviarlos, podría fabricar un defecto que dice venir de una
> ejecución que nunca pasó, y la trazabilidad dejaría de ser evidencia. Separo
> severidad de prioridad porque una es el daño y la otra la decisión de negocio.
> Y mantengo reopened como estado propio, limpiando las fechas de resolución al
> reabrir, porque una regresión y un bug que nunca se arregló no son lo mismo
> para nadie que lea el informe.

## MVP frente a futuro

| Decisión | Ahora | Después |
| --- | --- | --- |
| Comentarios | No hay | Hilo por defecto |
| Adjuntos | Solo metadatos | Capturas y vídeos reales |
| Workflow | Tabla fija en el servicio | Configurable por organización |
| Duplicados | No hay | Relación de duplicidad |
| Jira | `ExternalReference` preparado | Sincronización bidireccional |
| Notificaciones | No hay | Aviso al asignar y al reabrir |

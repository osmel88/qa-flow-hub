# 11 — El modelo de dominio

## Concepto

El modelo de dominio es la traducción del vocabulario del negocio (capítulo 01) a
entidades, relaciones y reglas. En este proyecto vive en
[`apps/api/prisma/schema.prisma`](../../apps/api/prisma/schema.prisma): 21
modelos y 20 enums. El resumen navegable está en
[`../domain-model.md`](../domain-model.md).

Este capítulo no repite la tabla de entidades. Explica las **cinco decisiones**
que definen el modelo, porque son las que tendrías que defender.

## Decisión 1 — La instantánea del caso

```prisma
model TestRunCase {
  caseSnapshot Json
  caseVersion  Int
  testCase     TestCase @relation(..., onDelete: Restrict)
  latestStatus TestResultStatus @default(untested)
}
```

**Problema que resuelve.** Un caso de prueba cambia. Si una ejecución de marzo
apunta al caso *actual*, el informe de marzo miente: dice que se verificó algo
que en marzo no decía eso.

**Solución.** Al incluir un caso en una ejecución se congela su título,
precondiciones, resultado esperado y pasos en `caseSnapshot`, y se anota
`caseVersion`. El enlace al caso vivo se mantiene para navegar y para la
trazabilidad, con `onDelete: Restrict`: un caso que se ejecutó alguna vez no
puede desaparecer.

**Coste.** Duplicación de datos y un `jsonb` por caso y ejecución. Se acepta:
la alternativa es un histórico que no se puede defender ante un auditor.

**`latestStatus`** es una proyección del último resultado. Es denormalización
deliberada: listar una ejecución de 300 casos con su estado actual, sin ella,
requiere una subconsulta correlacionada por fila.

## Decisión 2 — Resultados solo se insertan

`TestResult` no se actualiza ni se borra nunca. Reejecutar un caso inserta una
fila. Así:

- se conserva quién ejecutó qué y cuándo;
- "este caso falló dos veces antes de pasar" es una consulta, no una anécdota;
- no hay carreras de actualización sobre la misma fila.

Es un patrón *event sourcing* aplicado a una sola entidad, sin adoptar el estilo
para todo el sistema.

## Decisión 3 — Trazabilidad polimórfica

```prisma
model TraceabilityLink {
  sourceType LinkableEntity
  sourceId   String
  targetType LinkableEntity
  targetId   String
  linkType   TraceLinkType

  @@unique([organizationId, sourceType, sourceId, targetType, targetId, linkType])
}
```

**Alternativa descartada:** seis tablas de unión
(`requirement_test_cases`, `test_result_defects`, …). Funciona y tiene
integridad referencial de verdad. Pero cada tipo de enlace nuevo —releases,
riesgos, pruebas automatizadas— sería una migración, una tabla, un repositorio y
una consulta más en la matriz.

**Coste que pagamos:** `sourceId` y `targetId` no son claves foráneas, así que
la base de datos no impide un enlace huérfano. Se mitiga en tres puntos:

1. `LinkableEntity` es un enum, así que un tipo mal escrito no compila ni entra;
2. la restricción única cubre la tupla completa, evitando duplicados;
3. un `CHECK` prohíbe enlazar una entidad consigo misma.

Es un intercambio consciente: menos integridad declarativa a cambio de que
crecer no cueste migraciones.

## Decisión 4 — Claves legibles con contadores por proyecto

Los usuarios hablan de `WEB-C-102`, no de `clx3f9a...`. Cada proyecto lleva tres
contadores y la reserva ocurre dentro de la transacción que crea la entidad:

```ts
data: { [counter]: { increment: 1 } }
```

Una sola sentencia `UPDATE ... SET c = c + 1 RETURNING c`: sin condición de
carrera y sin reutilizar números tras un borrado. El `id` sigue siendo un `cuid`
opaco; la clave legible es para las personas.

## Decisión 5 — Borrado lógico selectivo

No todo se borra igual, y aplicar la misma política a todo es un error clásico:

| Dato | Política | Motivo |
| --- | --- | --- |
| Resultados y auditoría | Nunca se borran | Son el registro histórico |
| Requisitos, casos, ejecuciones, defectos, proyectos | `deletedAt` | La historia y los enlaces los referencian |
| Pasos, casos de ejecución | Cascada con su padre | No significan nada solos |
| Sesiones | Se revocan y caducan | Necesarias para la traza de auditoría |

Toda lectura de repositorio pasa por `active()`, que añade `deletedAt: null`.
Olvidarlo es el bug típico del borrado lógico: filas "borradas" reapareciendo en
un listado.

## Verlo funcionando

El seed crea deliberadamente una **laguna de cobertura**: el requisito `*-R-2`
no tiene ningún caso enlazado. Es el dato que la matriz de trazabilidad debe
destacar, y sirve para comprobar que la funcionalidad hace algo real.

```bash
npm run db:seed
docker compose exec postgres psql -U qaflow -d qa_flow_hub -c \
  "SELECT r.key, count(t.*) AS cases
     FROM requirements r
     LEFT JOIN traceability_links t
       ON t.\"sourceId\" = r.id AND t.\"linkType\" = 'verifies'
    GROUP BY r.key ORDER BY r.key;"
```

## Errores comunes

- **Guardar el resultado como un campo del caso.** Pierdes histórico y no puedes
  ejecutar el mismo caso en dos releases.
- **Editar una instantánea.** Deja de ser una instantánea.
- **Olvidar `deletedAt: null`** en una consulta nueva.
- **Enlazar por `key` en vez de por `id`.** Las claves legibles son estables,
  pero el identificador es el `id`.
- **Meter estado de UI en el modelo** (columnas "expandido", "seleccionado").

## Preguntas de repaso

1. ¿Qué se rompe si `TestRunCase` no guardara la instantánea?
2. ¿Qué integridad se pierde con la trazabilidad polimórfica y cómo se
   compensa?
3. ¿Por qué `latestStatus` es denormalización aceptable?
4. ¿Por qué unas entidades se borran lógicamente y otras nunca?

## Ejercicios

1. Dibuja el diagrama entidad-relación de memoria y compáralo con
   [`../database-diagram.md`](../database-diagram.md).
2. Añade el enlace `Requirement → Defect` en el seed y escribe la consulta
   "defectos que afectan a requisitos aprobados".
3. Propón cómo modelarías "releases" reutilizando `TraceabilityLink` sin
   migración de las tablas existentes.

## Qué diría en una entrevista

> "Las dos decisiones que definen el modelo son que los resultados son
> append-only y que un caso se congela al entrar en una ejecución. Las dos
> existen por el mismo motivo: un informe de release tiene que seguir siendo
> cierto seis meses después, y si editar un caso reescribe la historia, el
> producto no sirve para lo único que se le pide. La tercera es una tabla
> polimórfica de trazabilidad: renuncio a integridad referencial en los
> extremos, a cambio de que añadir un tipo de enlace no sea una migración."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Versiones de casos | Contador + instantánea | Historial completo como el de requisitos |
| Estados | Enums fijos | Estados configurables por organización |
| Adjuntos | Metadatos | Almacenamiento real |
| Trazabilidad | Consulta directa | Vista materializada si la matriz crece |

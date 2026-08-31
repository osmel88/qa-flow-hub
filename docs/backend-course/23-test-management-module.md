# 23 — Módulo de diseño de pruebas

## Concepto

Aquí vive el contenido que da sentido al producto: suites, secciones, casos y
pasos. Es el módulo con más estructura de todo el backend, porque es el único
con un **árbol**, una **lista ordenada** y una **operación de copia**.

```
Project ──< TestSuite ──< TestSection (se anida en sí misma)
                └──< TestCase ──< TestStep (ordenados)
```

## Qué problema resuelve

Un equipo de QA no tiene una lista plana de pruebas: tiene carpetas, y dentro
casos que se parecen mucho entre sí. Sin jerarquía ni duplicación, mil casos son
inmanejables.

## Archivos reales

```
packages/shared/src/test-design/test-design.contracts.ts
apps/api/src/modules/test-design/test-design.repository.ts
apps/api/src/modules/test-design/test-design.service.ts
apps/api/src/modules/test-design/test-design.controller.ts
apps/api/src/modules/test-design/test-design.module.ts
apps/api/test/test-design.int-spec.ts     33 tests
```

Un solo módulo para cuatro entidades, y un solo repositorio. Suites, secciones,
casos y pasos no se usan por separado: crear un caso valida su sección, borrar
una sección mueve casos. Separarlos en cuatro módulos obligaría a que cada uno
importara a los demás, que es la definición de un límite mal puesto.

## Endpoints

```
POST   /api/v1/test-suites
GET    /api/v1/test-suites?projectId=
PATCH  /api/v1/test-suites/:id
DELETE /api/v1/test-suites/:id
GET    /api/v1/test-suites/:id/sections        el árbol completo

POST   /api/v1/test-sections
PATCH  /api/v1/test-sections/:id               renombrar, reordenar, reubicar
DELETE /api/v1/test-sections/:id

POST   /api/v1/test-cases
GET    /api/v1/test-cases?projectId=&suiteId=&sectionId=&status=&type=&priority=
                         &automationStatus=&tag=&search=&includeArchived=
GET    /api/v1/test-cases/:id                  con sus pasos
PATCH  /api/v1/test-cases/:id
POST   /api/v1/test-cases/:id/steps            reemplaza la lista entera
POST   /api/v1/test-cases/:id/duplicate
POST   /api/v1/test-cases/:id/archive
POST   /api/v1/test-cases/:id/restore
DELETE /api/v1/test-cases/:id
```

## Los pasos se reemplazan enteros

Esta es la decisión que más simplifica el módulo:

```ts
async replaceSteps(testCaseId, steps, tx) {
  await tx.testStep.deleteMany({ where: this.scope({ testCaseId }) });
  if (steps.length === 0) return;
  await tx.testStep.createMany({
    data: steps.map((step, index) => ({ ...step, position: index + 1, ... })),
  });
}
```

La alternativa —`POST /steps`, `PATCH /steps/:id`, `DELETE /steps/:id` y un
`POST /steps/reorder`— tiene cuatro endpoints, un estado intermedio en el que dos
pasos comparten posición (y violan el único `(testCaseId, position)`), y un
cliente que debe calcular las posiciones. Reemplazar la lista completa hace que
**la posición se derive del orden del array**: el cliente no puede producir
huecos ni duplicados porque no elige el número.

El coste es real y hay que decirlo: los `id` de los pasos cambian en cada
guardado, así que nada externo puede apuntar a un paso concreto de forma estable.
Cuando los resultados por paso lo exijan (F6 guarda el resultado a nivel de caso,
no de paso), la solución no es volver al CRUD por paso, sino un `stableId` que
sobreviva al reemplazo.

Se hace dentro de una transacción: entre el `deleteMany` y el `createMany` el
caso no tiene pasos, y ese estado no debe ser visible.

## El árbol de secciones

Autorreferencia con tres reglas, todas en el servicio.

**Profundidad máxima de 5.** Cada nivel cuesta una consulta al recorrer el árbol
hacia arriba. Cinco es más de lo que necesita cualquier plan de pruebas y
suficientemente poco para que el recorrido sea barato.

**Sin ciclos.** Mover una sección dentro de su propia descendencia dejaría toda
la rama existiendo pero inalcanzable desde cualquier raíz:

```ts
if ((await this.descendantIds(section)).includes(parentId)) {
  throw new ValidationError('A section cannot be moved inside one of its own descendants');
}
```

**Un caso solo puede estar en una sección de su propia suite.** Sin esto, el
árbol de una suite mostraría casos que pertenecen a otra.

El árbol se construye con **una consulta y un `Map`**, no con una consulta por
nivel:

```ts
const views = new Map(sections.map((s) => [s.id, toSectionView(s, [])]));
for (const section of sections) {
  const parent = section.parentId === null ? undefined : views.get(section.parentId);
  (parent === undefined ? roots : parent.children).push(views.get(section.id));
}
```

Con la profundidad acotada, traer todas las secciones de una suite y armar el
árbol en memoria es más rápido que cualquier recursión en base de datos, y no
necesita CTE recursivas.

## Borrar no significa lo mismo en cada nivel

| Se borra | Le pasa a las secciones hijas | Le pasa a los casos |
| --- | --- | --- |
| Suite | Se borran | Se borran |
| Sección | Se borran las descendientes | **Sobreviven**, pasan a la raíz |

Borrar una suite es borrar el conjunto de pruebas. Borrar una carpeta es borrar
la carpeta: perder la organización no debe perder el trabajo. Es la diferencia
entre lo que el usuario cree que hace y lo que haría un `ON DELETE CASCADE`
ingenuo.

```ts
await tx.testCase.updateMany({
  where: this.active({ sectionId: { in: ids } }),
  data: { sectionId: null },
});
```

Todo es borrado lógico, así que las entradas de auditoría siguen apuntando a
filas reales.

## Versión del caso

`TestCase.version` se incrementa en cada edición y cada reescritura de pasos.
Todavía no lo usa nadie: F6 lo copiará al snapshot de la ejecución para que un
informe pueda decir **qué versión del caso se ejecutó**. Sin eso, editar un caso
reescribiría retroactivamente el significado de ejecuciones pasadas — un informe
diría que se probó algo que en ese momento no existía.

## Duplicar

Copia el caso y sus pasos con clave nueva, versión 1 y estado `draft`. Dos
detalles con criterio:

- **Un caso archivado se puede duplicar, y la copia no está archivada.**
  Duplicar es justamente como se revive una prueba antigua; heredar el archivado
  daría una copia inservible.
- **La sección destino se valida contra la suite del original**, igual que al
  crear.

## Archivado frente a borrado

Archivar es reversible, quita el caso de la planificación y lo esconde del
listado por defecto (`includeArchived=true` para verlo). Un caso archivado es de
solo lectura: editarlo devuelve 409 con un mensaje que dice qué hacer.

Importa porque los casos archivados **siguen apareciendo en ejecuciones
históricas**. Borrarlos rompería informes pasados.

## Qué prueban los 33 tests

Los que valen la pena mirar:

- **Aislamiento**: un usuario legítimo de otra organización con los `id` exactos
  intenta leer, editar, archivar, borrar, reescribir pasos, duplicar y colgar un
  caso de una sección ajena. Todo 404 o 400, y se comprueba además que la fila
  original quedó intacta —no basta con el código de estado—.
- **Cinco niveles sí, seis no.**
- **101 pasos se rechazan y no crean el caso**; 100 se aceptan y el último tiene
  posición 100.
- **El contador no se consume cuando la creación falla**, ni por validación ni
  por una sección de otra suite: el siguiente caso es `WEB-C-2`, no `WEB-C-3`.
- **Casos y requisitos numeran por contadores distintos**: `WEB-R-1` y `WEB-C-1`
  conviven.
- **La auditoría registra crear, archivar, restaurar y duplicar**, con usuario y
  organización, y **no registra nada cuando la operación se rechaza**.

## Comandos

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts test/test-design.int-spec.ts

# El árbol de una suite
curl -s localhost:3000/api/v1/test-suites/$SUITE/sections \
  -H "authorization: Bearer $TOKEN" -H "x-organization-id: $ORG" | jq
```

## Errores comunes

**CRUD por paso.** Cuatro endpoints, posiciones inconsistentes y un cliente que
tiene que calcular índices.

**Reemplazar los pasos fuera de una transacción.** Una ventana en la que el caso
no tiene ninguno.

**Recorrer el árbol con una consulta por nivel.** Con una consulta y un `Map`
basta cuando la profundidad está acotada.

**Permitir profundidad ilimitada.** Un cliente puede crear mil niveles y cada
recorrido se vuelve mil consultas.

**No comprobar los ciclos al reubicar.** Una rama huérfana que sigue en la base
de datos y no aparece en ninguna pantalla.

**Borrar los casos al borrar su sección.** Destruye trabajo que el usuario creía
que solo estaba cambiando de carpeta.

**Borrado físico de casos.** Rompe las ejecuciones históricas que los referencian.

## Preguntas de repaso

1. ¿Por qué los pasos se reemplazan enteros y qué se pierde a cambio?
2. ¿Por qué el reemplazo va dentro de una transacción?
3. ¿Qué pasaría si se permitiera mover una sección dentro de su descendencia?
4. ¿Por qué borrar una suite borra sus casos y borrar una sección no?
5. ¿Para qué sirve `TestCase.version` si todavía nadie lo lee?
6. ¿Por qué una copia de un caso archivado no está archivada?
7. ¿Por qué las cuatro entidades comparten un módulo y un repositorio?

## Ejercicios

1. Añade `POST /test-cases/:id/move` para cambiar un caso de suite, decidiendo
   qué pasa con su sección y con su clave. Escribe primero los tests.
2. Implementa `stableId` en los pasos para que sobrevivan al reemplazo, sin
   volver al CRUD por paso.
3. Añade un endpoint de reordenación masiva de secciones que reciba la lista de
   `(id, position)` y la aplique en una transacción.
4. Mide el árbol con 5 000 secciones y compara la construcción en memoria con
   una CTE recursiva en PostgreSQL.
5. Implementa la importación de casos desde CSV reutilizando el servicio, con una
   sola transacción y un resumen de errores por fila.

## Qué diría en una entrevista

> Es el módulo con más estructura: un árbol, una lista ordenada y una copia. Los
> pasos se reemplazan como lista completa dentro de una transacción, así que la
> posición se deriva del orden del array y el cliente no puede producir huecos ni
> chocar con el único (testCaseId, position); a cambio los ids de los pasos no
> son estables, y lo asumo conscientemente. El árbol de secciones está acotado a
> cinco niveles y se construye con una consulta y un Map en lugar de una consulta
> por nivel, y reubicar valida que no se cree un ciclo, porque una rama movida
> bajo su propia descendencia seguiría existiendo sin que ninguna raíz la
> alcance. Y borrar una carpeta no borra las pruebas que contiene: eso es lo que
> el usuario espera, aunque un ON DELETE CASCADE dijera otra cosa.

## MVP frente a futuro

| Decisión | Ahora | Después |
| --- | --- | --- |
| Pasos | Reemplazo completo | `stableId` cuando haya resultados por paso |
| Versión del caso | Contador entero | Snapshot completo por versión, como en requisitos |
| Profundidad | 5 niveles | Configurable, o `ltree` de PostgreSQL |
| Plantillas | No hay | Casos plantilla y creación desde plantilla |
| Adjuntos | Solo metadatos | Almacenamiento real de evidencias |
| Búsqueda | `ILIKE` sobre título y clave | Búsqueda de texto completo con ranking |

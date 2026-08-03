# 22 — Módulo de requisitos

## Concepto

Un requisito es lo que el producto debe hacer: una historia de usuario, un
requisito no funcional, un épico. En una herramienta de QA es el nodo raíz de la
trazabilidad: sin requisitos, "¿qué cobertura tiene esta release?" no tiene
respuesta, porque no hay nada que cubrir.

## Qué problema resuelve

Tres cosas que este módulo introduce por primera vez y que reaparecerán en F5–F7:

1. **Claves legibles** reservadas transaccionalmente (`WEB-R-14`).
2. **Historial versionado** de una entidad editable.
3. **Un flujo de estados** con transiciones legales, no un `enum` libre.

## Archivos reales

```
packages/shared/src/requirements/requirement.contracts.ts
apps/api/src/modules/requirements/requirements.repository.ts
apps/api/src/modules/requirements/requirements.service.ts
apps/api/src/modules/requirements/requirements.controller.ts
apps/api/src/modules/requirements/requirements.module.ts
apps/api/test/requirements.int-spec.ts     24 tests
apps/api/test/utils/workspace.ts           el arranque compartido de los tests
```

## Endpoints

```
POST   /api/v1/requirements
GET    /api/v1/requirements?projectId=&status=&type=&priority=&tag=&search=&page=
GET    /api/v1/requirements/:id
GET    /api/v1/requirements/:id/history
PATCH  /api/v1/requirements/:id
POST   /api/v1/requirements/:id/status
DELETE /api/v1/requirements/:id
```

`projectId` es obligatorio en el listado. Un listado de todos los requisitos de
la organización no responde a ninguna pregunta que alguien haga en esta
herramienta, y una consulta sin filtro de proyecto se convierte en un escaneo
grande el día que un cliente tenga cincuenta proyectos.

## Claves legibles: por qué no basta con un UUID

`WEB-R-14` se pega en un chat, se dicta por teléfono y se busca en Jira. Un cuid
no. La clave es parte de la interfaz humana del producto.

```ts
const project = await tx.project.update({
  where: { id: projectId, organizationId: this.organizationId },
  data: { requirementCounter: { increment: 1 } },
  select: { key: true, requirementCounter: true, /* ... */ },
});
return `${project.key}-R-${project.requirementCounter}`;
```

Dos decisiones dentro de tres líneas.

**El contador vive en `projects`, no en una secuencia de PostgreSQL.** Una
secuencia es global y no se puede reiniciar por proyecto ni por tenant; además
las secuencias no se revierten con la transacción, así que un fallo dejaría un
hueco. Un contador por fila sí se revierte.

**Incremento y lectura son una sentencia.** `UPDATE ... RETURNING` es atómico:
dos peticiones simultáneas obtienen 14 y 15, nunca 14 y 14. El equivalente
ingenuo, `SELECT max(key)+1`, es una condición de carrera escrita a mano.

Y la reserva ocurre **dentro** de la transacción del requisito:

```ts
it('does not burn a key when creation fails', async () => {
  await createRequirement();
  await failedCreate();                              // 404
  expect((await createRequirement()).json().key).toBe('WEB-R-2');
});
```

Sin transacción, el fallo intermedio habría consumido el 2 y el siguiente
requisito sería `WEB-R-3`, con un hueco que alguien tendría que explicar.

## Historial: tabla, no columna JSON

```prisma
model RequirementVersion {
  requirementId String
  version       Int
  snapshot      Json
  changedById   String?
  changedAt     DateTime @default(now())

  @@unique([requirementId, version])
}
```

Podría ser un array JSON en la propia fila del requisito. Sería peor por tres
motivos: la fila crecería sin límite, cada edición reescribiría todo el historial
y "¿qué decía esto en marzo?" sería un escaneo en lugar de una consulta indexada.

El `snapshot` se toma **después** de escribir:

```ts
const row = await this.requirements.update(id, { ... }, tx);
await this.requirements.appendVersion(id, snapshotOf(row), userId, tx);
```

Cada versión describe lo que el requisito **decía**, no lo que dejó de decir. La
versión 1 es el estado inicial, y el estado anterior a cualquier versión es la
versión previa. Guardar el estado anterior obligaría a leer hacia atrás y dejaría
la última edición sin registrar.

El número de versión sale de contar filas dentro de la transacción, y el índice
único `(requirementId, version)` es la garantía real si dos ediciones llegaran a
solaparse: la segunda falla y se reintenta, en lugar de producir dos versiones 3.

## Flujo de estados

```ts
const ALLOWED_TRANSITIONS: Record<RequirementStatus, RequirementStatus[]> = {
  draft:       ['in_review', 'obsolete'],
  in_review:   ['draft', 'approved', 'obsolete'],
  approved:    ['in_review', 'implemented', 'obsolete'],
  implemented: ['approved', 'obsolete'],
  obsolete:    ['draft'],
};
```

Un `enum` sin tabla de transiciones permite pasar de `draft` a `implemented`
saltándose la revisión, y entonces "aprobado" no significa nada: no se puede
afirmar que todo lo implementado pasó por revisión.

`obsolete` es alcanzable desde cualquier estado porque decidir que algo ya no
hace falta puede ocurrir en cualquier momento, y es la alternativa reversible al
borrado.

El endpoint es propio, `POST /:id/status`, y no un campo de `PATCH`:

```ts
expect(response.json().error.message).toContain('draft to implemented');
```

## Qué NO se puede editar

`updateRequirementSchema` no acepta `status` ni `projectId`.

`status` porque tiene su flujo. `projectId` porque mover un requisito de proyecto
invalidaría su clave (`WEB-R-14` en un proyecto llamado `MOB`), sus enlaces de
trazabilidad y la coherencia de su historial. Si alguna vez hace falta, será una
operación explícita que reasigne clave y registre el movimiento, no un campo.

Y como Zod descarta las claves desconocidas, un `PATCH` que solo lleve `status`
llega vacío. Eso se rechaza:

```ts
.refine((value) => Object.keys(value).length > 0, {
  message: 'Provide at least one field to update',
});
```

Es más honesto que no hacer nada y añadir una versión que no registra ningún
cambio.

## Etiquetas

```ts
export const tagsSchema = z
  .array(z.string().trim().toLowerCase().min(1).max(32))
  .max(20)
  .transform((tags) => Array.from(new Set(tags)));
```

Texto libre a propósito: un vocabulario controlado es una funcionalidad con su
pantalla de gestión, y los equipos etiquetan a su manera. Lo que sí se hace es
normalizar, para que `Login`, `login ` y `LOGIN` sean una etiqueta y no tres.

Se filtran con el operador de array de PostgreSQL, no con `LIKE`:

```ts
...(filters.tag === undefined ? {} : { tags: { has: filters.tag } }),
```

## El helper de tests

A partir de este módulo, cada suite necesita el mismo arranque: un propietario,
una organización y un proyecto. Está en `test/utils/workspace.ts`, con
`addMember(role)` para probar permisos.

No es solo comodidad: cada suite lo construye **a través de la API**, con
registro, invitación y aceptación reales. Los datos de prueba entran por el mismo
camino que los de producción, así que un test no puede pasar apoyándose en un
estado que la aplicación nunca produciría.

## Comandos

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts test/requirements.int-spec.ts

# Historial de un requisito
curl -s localhost:3000/api/v1/requirements/$ID/history \
  -H "authorization: Bearer $TOKEN" -H "x-organization-id: $ORG" | jq '.[].version'
```

## Errores comunes

**Usar una secuencia de PostgreSQL para la clave.** Global, no reiniciable por
tenant, y no se revierte con la transacción.

**Reservar la clave fuera de la transacción.** Huecos en la numeración cada vez
que algo falle.

**Guardar el historial como JSON en la propia fila.** Crece sin límite y se
reescribe entero en cada edición.

**Permitir cualquier transición de estado.** El estado deja de significar algo.

**Filtrar etiquetas con `LIKE '%tag%'`.** Además de no poder usar índice,
`auth` casaría con `oauth`.

**Listar sin filtro obligatorio de proyecto.** Funciona con datos de prueba y se
degrada con datos reales.

## Preguntas de repaso

1. ¿Por qué el contador está en `projects` y no en una secuencia?
2. ¿Qué pasaría con la numeración si `nextKey` se llamara fuera de la
   transacción?
3. ¿Por qué el snapshot se toma después de la escritura y no antes?
4. ¿Qué garantiza que no existan dos versiones con el mismo número?
5. ¿Por qué `projectId` no es editable?
6. ¿Por qué un `PATCH` que solo lleva `status` devuelve 400 y no 200?

## Ejercicios

1. Añade `GET /requirements/:id/coverage` que devuelva los casos de prueba
   enlazados. Necesitarás F5; escribe primero el contrato.
2. Implementa la reversión a una versión anterior. Decide si crea una versión
   nueva o reescribe, y justifica la decisión en un comentario.
3. Añade `blocked` al flujo de estados y define desde dónde y hacia dónde se
   puede llegar. Escribe los tests de las transiciones ilegales.
4. Mide con `EXPLAIN ANALYZE` el listado filtrado por etiqueta con 100 000
   requisitos y decide si hace falta un índice GIN.
5. Implementa la importación de requisitos desde CSV reutilizando el servicio,
   con una sola transacción para todo el lote.

## Qué diría en una entrevista

> El módulo introduce tres patrones que reutilizan los siguientes. Las claves
> legibles se reservan con un UPDATE ... RETURNING sobre un contador del
> proyecto, dentro de la transacción de la entidad, así que no hay carreras ni
> huecos cuando algo falla; una secuencia de PostgreSQL no valdría porque es
> global y no se revierte. El historial es una tabla append-only con un snapshot
> por versión y un único (requirementId, version), en lugar de un JSON que
> crecería sin límite en la propia fila. Y el estado tiene una tabla de
> transiciones legales con su propio endpoint: si se pudiera pasar de borrador a
> implementado, "aprobado" no significaría nada.

## MVP frente a futuro

| Decisión | Ahora | Después |
| --- | --- | --- |
| Historial | Snapshot completo por versión | Diffs si el volumen molesta; el snapshot es más simple de leer |
| Flujo | Tabla fija en el código | Configurable por organización, con motor de estados |
| Etiquetas | Array normalizado | Índice GIN y autocompletado |
| Aprobación | Cambio de estado auditado | Aprobación con firma y varios aprobadores |
| Referencias externas | Tabla lista, sin uso | Enlace bidireccional con Jira |

# 26 — Trazabilidad

## Concepto

Trazabilidad es poder responder, con datos y no de memoria: **¿qué requisito
cubre esta prueba?**, **¿qué prueba demuestra que esto funciona?**, **¿qué
defecto rompió esta historia?**.

Es lo que un auditor pide y lo que diferencia una herramienta de QA de una hoja
de cálculo.

## Qué problema resuelve

Sin trazabilidad, un equipo puede tener 800 casos y no saber que la historia más
crítica del release no tiene ninguno. La matriz existe para que esa pregunta
tenga respuesta en un endpoint y no en una reunión.

## Archivos reales

```
packages/shared/src/traceability/traceability.contracts.ts
apps/api/src/modules/traceability/traceability.repository.ts
apps/api/src/modules/traceability/traceability.service.ts
apps/api/src/modules/traceability/traceability.controller.ts
apps/api/test/defects.int-spec.ts        matriz y enlaces
```

El módulo **no posee ninguna entidad de negocio**: solo la tabla de enlaces y
consultas de lectura. Es el ejemplo de un módulo que existe por una pregunta, no
por un sustantivo.

## Endpoints

```
POST   /api/v1/traceability/links
GET    /api/v1/traceability/links?entityType=&entityId=
DELETE /api/v1/traceability/links/:id
GET    /api/v1/traceability/matrix?projectId=&uncoveredOnly=
```

## Una tabla polimórfica en vez de seis de unión

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

Las relaciones que el producto necesita son al menos seis: requisito–caso,
caso–run, resultado–defecto, requisito–defecto, caso–test automatizado,
requisito–requisito. Con tablas de unión, cada tipo nuevo de relación es una
migración; con esta tabla, es un valor de enum.

**Lo que se pierde y hay que asumir explícitamente:** no hay clave foránea. La
base de datos no impide un enlace a un id que no existe. Por eso la integridad se
comprueba en el servicio, contra el tenant, antes de crear el enlace:

```ts
if (!(await this.reads.entityExists(type, id))) {
  throw new ValidationError(`No ${type} with id ${id} in this organization`);
}
```

Comprobar los **dos extremos contra la organización activa** también cierra un
canal de fuga: sin ello, un enlace que se crea o falla revela si un id existe en
otra organización.

`LinkableEntity` es un enum, no texto libre: una errata no puede crear un enlace
huérfano que nadie encontrará jamás.

Y los enlaces se leen en **las dos direcciones**, porque un enlace es un hecho
sobre dos entidades, no una propiedad de una:

```ts
OR: [
  { sourceType: entityType, sourceId: entityId },
  { targetType: entityType, targetId: entityId },
]
```

## `covered` no es `verified`

Es la distinción que hace útil la matriz:

| Campo | Significa |
| --- | --- |
| `covered` | Alguien **escribió** al menos una prueba para el requisito |
| `verified` | Todas esas pruebas **se ejecutaron y pasaron**, y no hay ningún defecto abierto asociado |

```ts
verified:
  linked.length > 0 &&
  linked.every((testCase) => testCase.lastStatus === 'passed') &&
  (defectsByRequirement.get(requirement.id) ?? []).length === 0,
```

Un informe que solo mide cobertura invita a escribir casos vacíos: la métrica
sube y no se prueba nada. Con las dos columnas, la diferencia entre ellas es
precisamente el trabajo pendiente.

Un defecto abierto vetando `verified` es deliberado: da igual que la prueba
pasara ayer si hoy hay un bug vivo sobre ese requisito.

## Cuatro consultas, ninguna por requisito

La ingenuidad aquí es cara: por cada requisito, buscar sus enlaces; por cada
enlace, cargar el caso; por cada caso, su último resultado. Con 200 requisitos
son cientos de consultas.

La construcción real es:

1. los requisitos del proyecto (excluyendo `obsolete`);
2. todos los enlaces requisito→caso de esos requisitos, en una consulta;
3. los casos referenciados por esos enlaces, en una consulta;
4. el último estado de esos casos, en una consulta, más los defectos del
   proyecto.

Después, dos `Map` y un recorrido en memoria. El coste es constante en número de
consultas y lineal en filas, que es exactamente lo que se puede defender ante
cualquier tamaño de proyecto razonable.

Un detalle que importa: si un caso fue borrado, su enlace **sobrevive** y
simplemente no aparece en la fila. Borrar el enlace en cascada dejaría un
historial que no coincide con lo que se decidió en su día.

```ts
const testCase = caseById.get(link.targetId);
if (testCase === undefined) {
  continue;
}
```

## `uncoveredOnly` filtra filas, no el resumen

El resumen siempre describe el proyecto entero. Si filtrar por «sin cobertura»
cambiara también el resumen, el porcentaje de cobertura del proyecto sería 0 % en
esa vista — un número correcto y completamente inútil.

## Comandos

```bash
curl -s "localhost:3000/api/v1/traceability/matrix?projectId=$PROJECT&uncoveredOnly=true" \
  -H "authorization: Bearer $TOKEN" -H "x-organization-id: $ORG" \
  | jq '{coverage: .summary.coverage, gaps: [.rows[].key]}'
```

## Errores comunes

**Una tabla de unión por cada tipo de relación.** Cada tipo nuevo es una
migración.

**Texto libre en lugar de enum para el tipo de entidad.** Erratas invisibles.

**No validar la existencia al crear el enlace.** Sin claves foráneas, nadie más
lo hará.

**No validar el tenant en los dos extremos.** El endpoint revela ids ajenos.

**Leer los enlaces en una sola dirección.** Desde el caso no se ve el requisito.

**Confundir cobertura con verificación.** Se premia escribir casos vacíos.

**Construir la matriz con un bucle de consultas.** Funciona con 10 requisitos y
muere con 500.

**Borrar los enlaces cuando se borra la entidad.** Se pierde el historial.

## Preguntas de repaso

1. ¿Qué se gana y qué se pierde con la tabla polimórfica?
2. ¿Por qué se comprueban ambos extremos contra la organización activa?
3. ¿Cuál es la diferencia entre `covered` y `verified`, y por qué importa?
4. ¿Por qué un defecto abierto impide que un requisito esté verificado?
5. ¿Cuántas consultas cuesta la matriz y por qué no depende del número de filas?
6. ¿Por qué el resumen no cambia al filtrar por `uncoveredOnly`?

## Ejercicios

1. Añade una vista inversa: casos que no cubren ningún requisito (pruebas
   huérfanas).
2. Materializa la cobertura en el proyecto y decide cómo invalidarla.
3. Implementa la exportación de la matriz a CSV en streaming, sin cargarla entera
   en memoria.
4. Añade `automates` de `test_case` a `automated_test` usando
   `ExternalReference` y muéstralo en la matriz.
5. Escribe una consulta SQL que detecte enlaces huérfanos y conviértela en un
   comando de mantenimiento.

## Qué diría en una entrevista

> La trazabilidad es una sola tabla polimórfica con un único compuesto en lugar
> de seis tablas de unión, porque los tipos de relación van a crecer y un tipo
> nuevo no debería ser una migración. El precio es que no hay clave foránea, así
> que valido la existencia de los dos extremos en el servicio y siempre contra la
> organización activa, que además evita usar el endpoint para averiguar si un id
> existe en otro tenant. En la matriz separo cobertura de verificación:
> «cubierto» es que alguien escribió una prueba, «verificado» es que se ejecutó,
> pasó y no hay defectos abiertos; si solo mides cobertura, incentivas casos
> vacíos. Y se construye con cuatro consultas y dos mapas, no con un bucle por
> requisito.

## MVP frente a futuro

| Decisión | Ahora | Después |
| --- | --- | --- |
| Integridad de enlaces | En el servicio | Triggers o comprobación periódica |
| Matriz | Al vuelo | Materializada por proyecto |
| Exportación | JSON | CSV y PDF |
| Tests automatizados | Enum preparado | Enlace real vía adaptador de CI |
| Cobertura | Requisito→caso | Ponderada por prioridad y riesgo |

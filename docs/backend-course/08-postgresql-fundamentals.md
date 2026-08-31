# 08 — Fundamentos de PostgreSQL

## Concepto

PostgreSQL es una base de datos relacional: los datos viven en tablas con
columnas tipadas, las relaciones se declaran con claves foráneas y el motor
garantiza propiedades (ACID) que la aplicación no tiene que reimplementar.

Este capítulo cubre lo que este backend usa de verdad, no SQL entero.

## Qué problema resuelve

Podríamos guardar todo en ficheros JSON. Lo que perderíamos:

- **Atomicidad.** "Crear el defecto, marcar el resultado y aumentar el contador"
  o pasa entero o no pasa. Sin transacciones, un fallo a mitad deja datos
  inventados.
- **Restricciones bajo concurrencia.** "Solo una invitación pendiente por correo
  y organización" no se puede garantizar con un `if` en el código: entre la
  comprobación y la escritura cabe otra petición. Un índice único sí lo
  garantiza.
- **Consultas relacionales.** La matriz de trazabilidad es un join de cuatro
  tablas. Escrito a mano en memoria son cientos de líneas y varios órdenes de
  magnitud más lento.

## Los tipos que usamos

| Tipo | Dónde | Por qué |
| --- | --- | --- |
| `text` | Casi todas las cadenas | En PostgreSQL `varchar(n)` no es más rápido; el límite se valida en la aplicación con Zod |
| `timestamp(3)` | `createdAt`, `deletedAt` | Precisión de milisegundos |
| `boolean` | `isActive` | — |
| `integer` | Contadores, posiciones | — |
| `jsonb` | `caseSnapshot`, `changes`, `settings` | Binario, indexable, con operadores propios |
| `text[]` | `tags` | Evita una tabla de unión para algo que solo se filtra |
| Enums nativos | Estados y roles | Validados por el motor, no solo por la aplicación |

Sobre `jsonb`: es la herramienta correcta para datos cuya **forma no participa
en consultas relacionales**. `caseSnapshot` se lee entero para mostrarlo; nunca
se hace join contra él. Si algún día hay que consultarlo, será señal de que
debía ser una tabla.

## Índices

Un índice es una estructura que evita leer la tabla entera. Cuestan espacio y
escrituras, así que se ponen donde hay lecturas.

La regla de este proyecto: **todo índice de datos funcionales empieza por
`organizationId`**, porque todas las consultas filtran por él.

```sql
CREATE INDEX "projects_organizationId_status_idx" ON "projects" ("organizationId", "status");
```

El orden importa. Un índice `(a, b)` sirve para filtrar por `a` y por `a AND b`,
pero **no** para filtrar solo por `b`. Es el mismo principio que buscar en una
guía telefónica ordenada por apellido y luego nombre.

### Índices únicos parciales

```sql
CREATE UNIQUE INDEX "organization_invitations_pending_unique"
  ON "organization_invitations" ("organizationId", "email")
  WHERE "status" = 'pending';
```

La cláusula `WHERE` es lo que hace posible el requisito: unicidad solo entre las
filas pendientes, de modo que reinvitar tras revocar sigue funcionando. Esta
característica no existe en MySQL y es una de las razones de elegir PostgreSQL.

### Check constraints

```sql
ALTER TABLE "projects" ADD CONSTRAINT "projects_key_uppercase" CHECK ("key" = upper("key"));
```

Una invariante que el motor no deja violar, ni siquiera desde `psql`. Se usan
para reglas que serían un desastre si se colaran: claves en minúsculas,
contadores negativos, enlaces de trazabilidad de una entidad a sí misma.

## Claves foráneas y qué pasa al borrar

```prisma
organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
assignee     User?        @relation(fields: [assigneeId],     references: [id], onDelete: SetNull)
testCase     TestCase     @relation(fields: [testCaseId],     references: [id], onDelete: Restrict)
```

Las tres políticas están elegidas caso por caso:

- **`Cascade`** desde la organización: si se elimina un tenant, se va todo lo
  suyo. Es lo correcto y es también lo que exige el derecho al borrado.
- **`SetNull`** para personas: si se borra un usuario, el defecto sigue
  existiendo sin responsable. Perder el defecto sería peor.
- **`Restrict`** desde `TestRunCase` hacia `TestCase`: no se puede eliminar de
  verdad un caso que participó en una ejecución. La historia manda.

## Transacciones

```ts
// apps/api/src/database/prisma.service.ts
runInTransaction<T>(work: (tx: PrismaTransaction) => Promise<T>, options?): Promise<T> {
  return this.$transaction(work, { timeout: options?.timeoutMs ?? 10_000, ... });
}
```

El `timeout` no es decorativo: una transacción abierta mantiene bloqueos, y una
transacción olvidada bloquea a todos los demás. Diez segundos es generoso para
cualquier operación de este producto; si algo tarda más, es un bug.

El capítulo 17 desarrolla aislamiento y errores de serialización.

## Comandos

```bash
docker compose exec postgres psql -U qaflow -d qa_flow_hub

\dt                          -- tablas
\d projects                  -- estructura, índices y restricciones
\di                          -- índices
SELECT * FROM organizations;
EXPLAIN ANALYZE SELECT * FROM projects WHERE "organizationId" = '...' AND status = 'active';
\q
```

Merece la pena ejecutar `\d projects` una vez: verás las cuatro restricciones
escritas a mano junto a las que generó Prisma.

## Errores comunes

- **Índice en el orden equivocado.** `(status, organizationId)` no sirve para
  las consultas de este producto.
- **Confiar en un `if` para la unicidad.** Entre `SELECT` e `INSERT` cabe otra
  petición. La unicidad la garantiza el índice; el `if` solo da un mensaje de
  error más bonito.
- **`SELECT *` en tablas con `jsonb` grande.** Trae `caseSnapshot` entero para
  listar nombres.
- **N+1.** Listar 50 casos y pedir sus pasos uno a uno son 51 consultas. Usa
  `include` o una segunda consulta con `in`.
- **Olvidar que `NULL` no es igual a nada.** `WHERE deletedAt != NULL` no
  devuelve nunca nada; es `IS NOT NULL`.

## Preguntas de repaso

1. ¿Por qué todos los índices empiezan por `organizationId`?
2. ¿Qué permite un índice único parcial que uno normal no permite?
3. ¿Cuándo `SetNull` y cuándo `Restrict` en una clave foránea?
4. ¿Por qué `caseSnapshot` es `jsonb` y no tablas?

## Ejercicios

1. Con los datos del seed, escribe la consulta que devuelve los requisitos sin
   ningún `TraceabilityLink` de tipo `verifies`. Debe salir `*-R-2`.
2. Ejecuta `EXPLAIN ANALYZE` sobre esa consulta. Añade un índice que la mejore y
   mide otra vez.
3. Intenta insertar a mano un proyecto con clave en minúsculas desde `psql` y
   copia el error.

## Qué diría en una entrevista

> "Elegimos PostgreSQL porque el dominio es relacional y porque hay invariantes
> que solo el motor puede garantizar bajo concurrencia. El ejemplo que suelo
> poner es 'una sola invitación pendiente por correo y organización': con un
> `if` en el código hay una condición de carrera entre la comprobación y la
> escritura, y con un índice único normal no puedes reinvitar tras revocar. Un
> índice único parcial resuelve las dos cosas a la vez."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Escalado | Una instancia | Réplicas de lectura para dashboards |
| `test_results` | Tabla única | Particionado por fecha |
| Búsqueda | `ILIKE` | Búsqueda de texto completo |
| Seguridad | Restricciones y aplicación | Row Level Security |

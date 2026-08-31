# 09 — Esquema y migraciones con Prisma

## Concepto

Prisma es un ORM con un enfoque poco habitual: el esquema se declara en su
propio lenguaje (`schema.prisma`), y a partir de él se **genera** un cliente
TypeScript con los tipos exactos de tus tablas. No escribes clases de entidad ni
decoradores: escribes el esquema y el cliente aparece.

De ahí una consecuencia práctica que sorprende al principio: `@prisma/client`
**no está en el repositorio**. Se genera. Sin `npm run db:generate`, el proyecto
no compila.

## Qué problema resuelve

Tres cosas, y conviene separarlas:

1. **Tipos que no mienten.** El tipo de `prisma.project.findMany()` se deriva de
   la tabla. Renombrar una columna rompe la compilación de todo lo que la usaba.
2. **Migraciones versionadas.** Cada cambio produce un fichero SQL en
   `prisma/migrations/`, revisable en el pull request y aplicable en orden.
3. **Consultas sin SQL para el 95 % de los casos**, con salida a SQL crudo
   tipado (`$queryRaw`) para el 5 % restante — que en este producto será la
   matriz de trazabilidad.

Ver [`../adr/0004-prisma-orm.md`](../adr/0004-prisma-orm.md).

## Archivos reales

- [`apps/api/prisma/schema.prisma`](../../apps/api/prisma/schema.prisma) — 21
  modelos y 19 enums.
- `apps/api/prisma/migrations/20260731224751_init/migration.sql` — 765 líneas
  generadas más cuatro restricciones escritas a mano.
- [`apps/api/prisma/seed.ts`](../../apps/api/prisma/seed.ts) — datos ficticios.
- [`apps/api/src/database/prisma.service.ts`](../../apps/api/src/database/prisma.service.ts)
  — el cliente como proveedor de Nest.

## Anatomía de un modelo

```prisma
model Project {
  id             String       @id @default(cuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  name   String
  key    String
  status ProjectStatus @default(active)

  requirementCounter Int @default(0)

  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt
  archivedAt DateTime?
  deletedAt  DateTime?

  @@unique([organizationId, key])
  @@index([organizationId, status])
  @@map("projects")
}
```

Punto por punto:

- **`cuid()` en vez de un entero autoincremental.** Un `id` secuencial filtra
  información de negocio (`/projects/47` revela cuántos proyectos hay en la
  instalación) y permite enumerar recursos. `cuid()` es opaco y se puede generar
  en el cliente.
- **`@@unique([organizationId, key])`, nunca `key` sola.** Dos clientes distintos
  tienen derecho a llamar `WEB` a su proyecto. Todas las restricciones de
  unicidad de datos funcionales empiezan por `organizationId`.
- **`@@index([organizationId, status])`.** El orden de las columnas importa:
  como toda consulta filtra por organización, esa columna va primero.
- **`@@map("projects")`.** TypeScript en singular con mayúscula inicial, SQL en
  plural y minúsculas. Cada mundo con su convención.
- **`deletedAt` y `archivedAt` son cosas distintas.** Archivar es un estado del
  negocio, visible y reversible por el usuario; borrar es una desaparición
  lógica.

## Los contadores de claves legibles

```prisma
requirementCounter Int @default(0)
testCaseCounter    Int @default(0)
defectCounter      Int @default(0)
```

Los usuarios necesitan hablar de "WEB-C-102", no de un cuid. La numeración se
reserva incrementando el contador **dentro de la transacción** que crea la
entidad:

```ts
// apps/api/src/modules/projects/projects.repository.ts
const project = await tx.project.update({
  where: { id: projectId, organizationId: this.organizationId },
  data: { [counter]: { increment: 1 } },
  select: { key: true, requirementCounter: true, /* ... */ },
});
return `${project.key}-${infix}-${project[counter]}`;
```

El incremento y la lectura son **una sola sentencia SQL**
(`UPDATE ... SET c = c + 1 RETURNING c`), así que dos peticiones concurrentes no
pueden recibir el mismo número. La alternativa ingenua —`SELECT max(key)`— tiene
una condición de carrera que se manifiesta justo cuando el producto empieza a
tener uso.

## Lo que Prisma no puede expresar

Cuatro restricciones se añadieron a mano al final de la migración. Las cuatro
son reglas que la aplicación no puede garantizar por sí sola:

```sql
-- Solo una invitación PENDIENTE por organización y correo. Una restricción
-- unique normal impediría también reinvitar tras una revocación.
CREATE UNIQUE INDEX "organization_invitations_pending_unique"
  ON "organization_invitations" ("organizationId", "email")
  WHERE "status" = 'pending';

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_key_uppercase" CHECK ("key" = upper("key"));

ALTER TABLE "traceability_links"
  ADD CONSTRAINT "traceability_links_no_self_link"
  CHECK (NOT ("sourceType" = "targetType" AND "sourceId" = "targetId"));

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_counters_non_negative"
  CHECK ("requirementCounter" >= 0 AND ...);
```

El índice parcial es el más interesante y el que resuelve exactamente el
requisito de producto: *impedir invitaciones activas duplicadas* sin impedir
reinvitar. Está cubierto por dos tests que comprueban las dos mitades de la
regla.

**Aviso sobre el flujo de trabajo:** si vuelves a ejecutar
`prisma migrate dev --create-only` para un cambio posterior, Prisma genera un
fichero nuevo; **no reescribe el anterior**, así que estas líneas no se pierden.
Lo que sí ocurre es que `prisma db push` (que nunca usamos aquí) las borraría,
porque sincroniza el esquema ignorando las migraciones.

## El servicio

```ts
// apps/api/src/database/prisma.service.ts
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> { await this.$connect(); }
  async onModuleDestroy(): Promise<void> { await this.$disconnect(); }
}
```

Extender el cliente y registrarlo como proveedor es lo que permite inyectarlo, y
lo que hace que `enableShutdownHooks()` cierre el pool ordenadamente.

Incluye también un `truncateAllTables()` para los tests, con un seguro:

```ts
if (process.env['NODE_ENV'] !== 'test') {
  throw new Error('truncateAllTables() is only available when NODE_ENV=test');
}
```

Un método que vacía la base de datos merece una guarda explícita, aunque solo lo
llamen los tests. Los tests se equivocan de `DATABASE_URL` con más frecuencia de
la que a nadie le gusta admitir.

## Comandos

```bash
npm run db:generate                  # regenerar el cliente (tras cambiar el esquema)
npx prisma format                    # ordenar el esquema
npx prisma validate                  # comprobar que es válido
npm run db:migrate:dev -w @qa-flow-hub/api -- --name add_something
npm run db:migrate                   # migrate deploy: aplicar en CI y producción
npm run db:seed
npm run db:reset                     # BORRA y recrea. Solo en desarrollo.
npx prisma studio                    # navegador de datos
```

## Errores comunes

- **`@prisma/client did not initialize yet`.** Falta `prisma generate`. Ocurre
  tras clonar, tras cambiar de rama y dentro de Docker si no se copia
  `node_modules/.prisma`.
- **Editar una migración ya aplicada.** Prisma guarda un checksum y se quejará.
  Los cambios se hacen con una migración nueva.
- **`prisma migrate dev` en producción.** Puede resetear la base. En producción
  y en CI, siempre `migrate deploy`.
- **`findUnique` con filtros extra.** Para un repositorio multi-tenant necesitas
  `findFirst`; ver capítulo 10.
- **Olvidar el índice.** Prisma no crea índices para las claves foráneas
  automáticamente en todos los casos. Si una consulta filtra por algo, ese algo
  necesita índice.

## Preguntas de repaso

1. ¿Por qué el cliente de Prisma no está en el repositorio y qué implica en CI?
2. ¿Por qué `@@unique([organizationId, key])` y no `key @unique`?
3. ¿Por qué el índice de invitaciones pendientes es *parcial*?
4. ¿Qué condición de carrera evita el contador con `increment`?

## Ejercicios

1. Añade `Requirement.estimatePoints Int?`, genera la migración, inspecciona el
   SQL y aplícala. Después revierte con una migración nueva.
2. Escribe una consulta con `$queryRaw` que devuelva, por proyecto, el número de
   requisitos sin ningún caso enlazado. Compárala con la versión equivalente
   usando el cliente.
3. Ejecuta `EXPLAIN ANALYZE` sobre un `findMany` filtrado por
   `organizationId` y `status`, con y sin el índice compuesto.

## Qué diría en una entrevista

> "El esquema es la fuente de verdad y el cliente se genera a partir de él, así
> que renombrar una columna rompe la compilación en lugar de romper producción.
> Toda restricción de unicidad de datos funcionales empieza por
> `organizationId`, porque dos clientes tienen derecho al mismo código de
> proyecto. Y lo que el lenguaje de Prisma no expresa lo escribo a mano en la
> migración: el mejor ejemplo es un índice único parcial que permite una sola
> invitación pendiente por correo y organización sin impedir reinvitar tras una
> revocación."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Migraciones | `migrate deploy` manual | Job previo al despliegue con rollback documentado |
| Consultas pesadas | Cliente de Prisma | `$queryRaw` para la matriz de trazabilidad |
| Particionado | No | `test_results` por fecha cuando crezca |
| RLS | No | Defensa en profundidad a nivel de base de datos |

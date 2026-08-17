# 10 — Diseño multi-tenant

## Concepto

Multi-tenancy es servir a varios clientes (*tenants*) desde una sola instalación
sin que ninguno vea los datos de otro. En qa-flow-hub el tenant es la
**organización**, y la regla es absoluta: ninguna respuesta puede contener una
fila cuyo `organizationId` no sea el de la organización activa de quien
pregunta.

Este es el capítulo más importante del curso. Un fallo aquí no es un bug: es una
fuga de datos entre clientes, y para un producto SaaS eso suele ser terminal.

## Tres estrategias posibles

| Estrategia | Aislamiento | Coste operativo | Coste por cliente nuevo |
| --- | --- | --- | --- |
| Base de datos por tenant | Máximo | Alto: N bases, N migraciones, N backups | Aprovisionar una base |
| Esquema por tenant | Alto | Medio: migraciones × N esquemas | Crear un esquema |
| **Fila por tenant (elegido)** | Depende del código | Bajo: una base, una migración | Insertar una fila |

Elegimos **fila por tenant con esquema compartido**: cada tabla funcional lleva
`organizationId`. Es la única de las tres en la que crear un cliente cuesta un
`INSERT`, y eso importa para un producto que quiere onboarding en autoservicio.

El precio es explícito y hay que decirlo en voz alta: **el aislamiento pasa a
depender del código de aplicación**. Con base de datos por tenant, olvidar un
filtro produce cero filas; aquí produce las filas de otro cliente. Por eso el
resto del capítulo trata de cómo hacer que olvidarlo sea difícil.

Ver [`../adr/0006-multi-tenancy-strategy.md`](../adr/0006-multi-tenancy-strategy.md).

## Qué problema resuelve la desnormalización

`TestStep` podría no llevar `organizationId`: se deduce por
`testCase → project → organization`. Lo lleva igualmente. Motivos:

1. **El filtro es un predicado indexado, sin joins.** Sin joins no hay joins mal
   escritos.
2. **La regla se puede verificar mecánicamente.** "Toda consulta pasa por
   `scope()`" es comprobable leyendo; "toda consulta une correctamente hasta la
   organización" no lo es.
3. **Hace posible Row Level Security** sin cambiar el modelo de datos: la
   política de cada tabla es un `=` contra su propia columna. Ya está activada;
   ver más abajo.

El coste es la posibilidad de incoherencia (un paso cuyo `organizationId` no
coincide con el de su caso). Se evita porque el `organizationId` nunca lo elige
el cliente: lo pone el repositorio desde el contexto.

## Las cuatro capas de defensa

```
1. Token         el JWT lleva el usuario; la organización activa se resuelve
                 y se verifica la pertenencia en cada petición
2. Guard         ActiveOrgGuard comprueba que existe una membresía viva y
                 escribe la organización en el contexto de la petición
3. Repositorio   TenantAwareRepository inyecta organizationId en TODA cláusula
                 where; un servicio no puede consultar sin él
4. Base datos    Row Level Security: la política de cada tabla compara
                 organizationId con app.current_organization, y la API se
                 conecta con un rol que NO es propietario de las tablas
```

Y una quinta que no es defensa sino prueba: **la suite de aislamiento**
([`apps/api/test/tenancy.int-spec.ts`](../../apps/api/test/tenancy.int-spec.ts)),
que intenta activamente el ataque realista —conozco el `id` exacto del recurso
de otra organización— y exige que falle.

## La cuarta capa: Row Level Security

Las tres primeras capas viven en nuestro código, y por tanto comparten un modo
de fallo: una línea olvidada. RLS responde a la única pregunta que el
repositorio no puede responder: *¿qué pasa si una consulta olvida el filtro?*
La respuesta tiene que ser "nada", no "los datos de otro cliente".

Hay tres decisiones dentro, y las tres son el capítulo:

**1. La API no es propietaria de las tablas.** PostgreSQL **exime al propietario
de una tabla de sus propias políticas**. Si la API se conecta con el rol que
ejecuta las migraciones, RLS no protege nada: es decoración con coste de
mantenimiento. De ahí dos conexiones:

| Variable | Rol | Quién la usa |
| --- | --- | --- |
| `DATABASE_MIGRATION_URL` | propietario | `prisma migrate`, seed, arnés de tests |
| `DATABASE_URL` | `qaflow_app` | la API en ejecución, y nadie más |

`qaflow_app` se crea en la migración sin contraseña —una contraseña en una
migración es un secreto commiteado— y `npm run db:grant-app-role` se la pone
desde el entorno. Rotarla es ese comando más un `DATABASE_URL` nuevo.

**2. La política falla cerrada.** `current_setting('app.current_organization',
true)` devuelve `NULL` cuando nadie la ha fijado, y `NULL` no es igual a nada:

```sql
CREATE POLICY tenant_isolation ON test_cases
  USING      ("organizationId" = current_setting('app.current_organization', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization', true));
```

`USING` filtra lo que se lee y lo que se puede modificar o borrar; `WITH CHECK`
impide **escribir** una fila de otra organización. Sin las dos, se podría no ver
a un cliente ajeno y a la vez plantarle datos.

**3. La variable se fija dentro de la transacción, nunca por conexión.** Es el
detalle que hace que RLS y un *pool* de conexiones puedan convivir:

```ts
// apps/api/src/database/prisma.service.ts
const [, result] = await client.$transaction([
  client.$executeRaw`SELECT set_config('app.current_organization', ${organizationId}, TRUE)`,
  query(args) as Prisma.PrismaPromise<unknown>,
]);
```

Ese `TRUE` significa "local a la transacción". Fijarla por conexión (`SET`, sin
transacción) parece más eficiente y es **el bug peor que no tener RLS**: Prisma
devuelve la conexión al pool con la organización de la petición anterior puesta,
así que la siguiente petición leería datos ajenos sin error alguno. Un fallo
silencioso y cruzado, en lugar de un fallo cerrado.

La extensión de cliente envuelve así **todas** las operaciones de modelo, y
`TenantAwareRepository` expone justamente ese cliente, para que ningún
repositorio tenga que acordarse de pedirlo.

### Qué queda deliberadamente fuera

`users`, `sessions`, `organizations`, `organization_members` y
`organization_invitations` no tienen política. Se leen **antes** de que exista una
organización activa: iniciar sesión, listar a qué organizaciones perteneces, ver
una invitación. Una política sobre la organización activa solo podría cumplirse
desactivándola en esos caminos, y una defensa que se apaga cuando molesta enseña
a apagarla. Su aislamiento sigue en el repositorio, con la suite que lo prueba.

### Cómo se demuestra

[`apps/api/test/rls.int-spec.ts`](../../apps/api/test/rls.int-spec.ts) es el único
spec que **se conecta como `qaflow_app`** y hace lo que ningún código de
producción debería hacer: consultar sin filtro. Sin organización anunciada,
`findMany()` devuelve 0 filas; con Acme activa, un `findMany({ where: {
organizationId: globex } })` devuelve 0; y `updateMany`/`deleteMany` sobre una
fila de Globex afectan a 0 filas —comprobado releyendo la fila como propietario,
porque "invisible" y "intacta" no son lo mismo—.

Los otros 218 tests siguen conectándose como propietario, y es correcto: prueban
la primera capa, y varios preparan dos organizaciones a la vez, algo que ninguna
conexión de un solo tenant puede hacer. Lo que sí corre con el rol restringido es
el **E2E completo**, que es la prueba de que ninguna política rompe un flujo
legítimo.

## Archivos reales

- [`apps/api/src/database/tenant-context.service.ts`](../../apps/api/src/database/tenant-context.service.ts)
- [`apps/api/prisma/migrations/20260816160000_row_level_security/migration.sql`](../../apps/api/prisma/migrations/20260816160000_row_level_security/migration.sql)
- [`apps/api/test/rls.int-spec.ts`](../../apps/api/test/rls.int-spec.ts)
- [`apps/api/src/database/tenant-aware.repository.ts`](../../apps/api/src/database/tenant-aware.repository.ts)
- [`apps/api/src/common/middleware/request-context.middleware.ts`](../../apps/api/src/common/middleware/request-context.middleware.ts)
- [`apps/api/src/modules/projects/projects.repository.ts`](../../apps/api/src/modules/projects/projects.repository.ts)
- [`apps/api/test/tenancy.int-spec.ts`](../../apps/api/test/tenancy.int-spec.ts)

## Código real

El contexto viaja en un `AsyncLocalStorage`, no como parámetro:

```ts
// apps/api/src/database/tenant-context.service.ts
private readonly storage = new AsyncLocalStorage<RequestContext>();

requireOrganizationId(): string {
  const organizationId = this.storage.getStore()?.organizationId;
  if (organizationId === undefined) {
    throw new UnauthenticatedError('No active organization in the request context');
  }
  return organizationId;
}
```

**Por qué `AsyncLocalStorage` y no un parámetro.** Un parámetro se puede
olvidar, y olvidarlo aquí significa una consulta sin filtro. Leerlo del
almacén invierte el defecto: si no hay organización, `requireOrganizationId()`
**lanza**. El peor caso posible pasa de "devuelve los datos de todos" a
"devuelve 401".

El middleware abre el contexto antes que cualquier guard, y llama a `next()`
**dentro** de `run()`, que es lo que hace que sobreviva a cada `await`:

```ts
// apps/api/src/common/middleware/request-context.middleware.ts
this.tenant.run({ requestId, ipAddress, userAgent }, next);
```

La clase base inyecta el filtro:

```ts
// apps/api/src/database/tenant-aware.repository.ts
protected scope<W extends object>(where?: W): W & { organizationId: string } {
  return { ...(where ?? ({} as W)), organizationId: this.organizationId };
}

protected active<W extends object>(where?: W): W & { organizationId: string; deletedAt: null } {
  return { ...(where ?? ({} as W)), organizationId: this.organizationId, deletedAt: null };
}
```

`organizationId` va **el último** en el objeto a propósito: aunque el llamante
incluyera el suyo en `where`, el *spread* lo sobrescribe. No se puede
suplantar la organización pasando un parámetro.

Y el detalle que más veces se hace mal en producción:

```ts
// apps/api/src/modules/projects/projects.repository.ts
async update(id: string, data: Prisma.ProjectUpdateInput): Promise<Project | null> {
  const { count } = await this.prisma.project.updateMany({ where: this.active({ id }), data });
  return count === 0 ? null : this.findById(id);
}
```

`update({ where: { id } })` modificaría **la fila de otra organización sin
protestar**, porque el `id` es único globalmente. `updateMany` con el filtro del
tenant no puede: el filtro es parte de la sentencia. Y `count === 0` significa
"no existe *en esta organización*", que es exactamente el 404 correcto. Lo mismo
aplica a `delete` frente a `deleteMany`.

Fíjate además en lo que **no** hay en ese repositorio: ningún método acepta un
argumento `organizationId`. No se puede pasar el equivocado ni olvidarlo.

## Lo que la prueba demuestra

```ts
// apps/api/test/tenancy.int-spec.ts
it('does not update another organization row', async () => {
  const result = await asOrganization(orgA, () => repository.update(projectB, { name: 'Hijacked' }));

  expect(result).toBeNull();
  const untouched = await prisma.project.findUniqueOrThrow({ where: { id: projectB } });
  expect(untouched.name).toBe('Beta Portal');
});

it('refuses to query at all when there is no active organization', async () => {
  await expect(repository.list(query)).rejects.toThrow(/No active organization/);
});
```

La segunda es la más valiosa: comprueba que el **modo de fallo** es negarse, no
devolverlo todo.

## Comandos

```bash
npm run test:integration -w @qa-flow-hub/api
npm run db:seed        # dos organizaciones con un miembro en común

# Ver a mano que los datos están separados
docker compose exec postgres psql -U qaflow -d qa_flow_hub \
  -c 'SELECT o.slug, count(p.*) FROM organizations o LEFT JOIN projects p ON p."organizationId" = o.id GROUP BY 1;'
```

## Errores comunes

- **`findUnique({ where: { id } })` en un repositorio de tenant.** No admite
  filtros adicionales de forma segura; usa `findFirst` con `active({ id })`.
- **`update`/`delete` por clave primaria.** El error más peligroso del capítulo.
  Siempre `updateMany`/`updateMany` con el filtro.
- **Aceptar `organizationId` en el cuerpo de la petición.** El cliente nunca
  elige su tenant; se deduce de la sesión.
- **Filtrar en el servicio "porque es más cómodo".** El servicio es donde vive
  la prisa. El repositorio es donde vive la garantía.
- **`include` sin filtro anidado.** Al incluir relaciones, las condiciones del
  padre no siempre bastan; incluye también `deletedAt: null` donde aplique.

## Preguntas de repaso

1. ¿Por qué `TestStep` lleva `organizationId` si podría deducirse?
2. ¿Qué diferencia hay, en términos de seguridad, entre `update` y `updateMany`?
3. ¿Por qué el contexto va en `AsyncLocalStorage` y no como parámetro?
4. ¿Cuál es el modo de fallo cuando no hay organización activa, y por qué se
   eligió ese?

## Ejercicios

1. Añade a `ProjectsRepository` un método `countByStatus()` **sin** usar
   `scope()`. Escribe un test que demuestre la fuga. Arréglalo. Guarda el
   diff: es el mejor recordatorio del capítulo.
2. Escribe un test que verifique que un `include` de miembros no filtra usuarios
   de otra organización.
3. Cambia el `TRUE` de `set_config` por `FALSE` (ámbito de sesión) y ejecuta el
   E2E varias veces. Cuando veas datos de otra organización sin un solo error,
   habrás entendido por qué RLS y *pooling* obligan a atar la variable a la
   transacción. Deshaz el cambio.
4. Haz a `qaflow_app` propietario de `requirements`
   (`ALTER TABLE requirements OWNER TO qaflow_app`) y ejecuta `rls.int-spec.ts`.
   Cuenta cuántos tests dejan de proteger algo y explica por qué.

## Qué diría en una entrevista

> "Uso tenancy por fila con esquema compartido, y asumo que el coste es que el
> aislamiento depende del código. Por eso no lo dejo a la disciplina: la
> organización activa vive en un AsyncLocalStorage y una clase base de
> repositorio la inyecta en todas las cláusulas where, de modo que ningún
> método acepta `organizationId` como argumento. Las modificaciones se expresan
> como `updateMany` con el filtro del tenant, porque un `update` por clave
> primaria modificaría la fila de otro cliente. Y hay una suite que intenta el
> ataque realista, conociendo el id exacto, y exige que falle.
>
> Debajo hay una segunda capa que no depende de nuestra disciplina: RLS en
> PostgreSQL. Lo importante ahí no es el `CREATE POLICY`, es que la API se
> conecta con un rol que no es propietario de las tablas —el propietario está
> exento de las políticas— y que la organización activa se fija con
> `set_config(..., TRUE)` dentro de la transacción de cada consulta, porque
> hacerlo por conexión con un pool filtraría datos entre peticiones sin dar un
> solo error."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Aislamiento | Aplicación + RLS + suite de pruebas | Política también en las tablas globales, por usuario |
| Clientes regulados | Esquema compartido | Despliegue dedicado por cliente |
| Auditoría de fugas | Tests | Alerta si una consulta se ejecuta sin filtro |

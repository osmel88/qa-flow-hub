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
3. **Deja la puerta abierta a Row Level Security** sin cambiar el modelo de
   datos.

El coste es la posibilidad de incoherencia (un paso cuyo `organizationId` no
coincide con el de su caso). Se evita porque el `organizationId` nunca lo elige
el cliente: lo pone el repositorio desde el contexto.

## Las tres capas de defensa

```
1. Token         el JWT lleva el usuario; la organización activa se resuelve
                 y se verifica la pertenencia en cada petición
2. Guard         ActiveOrgGuard comprueba que existe una membresía viva y
                 escribe la organización en el contexto de la petición
3. Repositorio   TenantAwareRepository inyecta organizationId en TODA cláusula
                 where; un servicio no puede consultar sin él
```

Y una cuarta que no es defensa sino prueba: **la suite de aislamiento**
([`apps/api/test/tenancy.int-spec.ts`](../../apps/api/test/tenancy.int-spec.ts)),
que intenta activamente el ataque realista —conozco el `id` exacto del recurso
de otra organización— y exige que falle.

## Archivos reales

- [`apps/api/src/database/tenant-context.service.ts`](../../apps/api/src/database/tenant-context.service.ts)
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
3. Investiga cómo activarías Row Level Security en PostgreSQL para la tabla
   `projects` y por qué el *pooling* de conexiones lo complica.

## Qué diría en una entrevista

> "Uso tenancy por fila con esquema compartido, y asumo que el coste es que el
> aislamiento depende del código. Por eso no lo dejo a la disciplina: la
> organización activa vive en un AsyncLocalStorage y una clase base de
> repositorio la inyecta en todas las cláusulas where, de modo que ningún
> método acepta `organizationId` como argumento. Las modificaciones se expresan
> como `updateMany` con el filtro del tenant, porque un `update` por clave
> primaria modificaría la fila de otro cliente. Y hay una suite que intenta el
> ataque realista, conociendo el id exacto, y exige que falle."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Aislamiento | Aplicación + suite de pruebas | Añadir RLS como defensa en profundidad |
| Clientes regulados | Esquema compartido | Despliegue dedicado por cliente |
| Auditoría de fugas | Tests | Alerta si una consulta se ejecuta sin filtro |

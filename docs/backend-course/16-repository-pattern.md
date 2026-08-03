# 16 — Patrón repositorio

## Concepto

Un repositorio es la única capa que habla con la base de datos. Expone métodos
con nombre de dominio (`findByKey`, `countOwners`, `rotate`) y esconde cómo se
consultan las tablas.

En un producto multi-tenant tiene además una segunda función, que aquí es la
principal: **es el sitio donde el filtro por organización se aplica siempre**.

## Qué problema resuelve

Con Prisma inyectado directamente en los servicios, el aislamiento entre clientes
depende de que nadie olvide `where: { organizationId }` en ninguna de las
cientos de consultas que tendrá el producto. Eso no es una arquitectura: es una
esperanza.

El repositorio convierte la regla en algo verificable leyendo el código:

> Ningún servicio importa Prisma. Toda consulta pasa por `scope()` o `active()`.

## Archivos reales

```
apps/api/src/database/tenant-aware.repository.ts              base
apps/api/src/modules/projects/projects.repository.ts          plantilla del resto
apps/api/src/modules/organizations/organizations.repository.ts        excepción documentada
apps/api/src/modules/organizations/organization-members.repository.ts excepción documentada
apps/api/src/modules/organizations/organization-invitations.repository.ts
apps/api/src/modules/auth/sessions.repository.ts
apps/api/test/tenancy.int-spec.ts                             la prueba
```

## La base

```ts
protected scope<W extends object>(where?: W): W & { organizationId: string } {
  return { ...(where ?? ({} as W)), organizationId: this.organizationId };
}

protected active<W extends object>(where?: W): W & { organizationId: string; deletedAt: null } {
  return { ...(where ?? ({} as W)), organizationId: this.organizationId, deletedAt: null };
}
```

Dos detalles deliberados.

**`organizationId` va al final del literal.** Si quien llama pasa el suyo, el
spread lo sobrescribe. No se puede colar otra organización aunque se intente.

**`this.organizationId` lanza si no hay ninguna.** No devuelve `undefined`, que
produciría una consulta sin filtro; lanza `UnauthenticatedError`.

## Lo que la base NO hace

No hay `findAll<T>()`, `create<T>()` ni un `BaseRepository<T>` genérico. Escribir
CRUD genérico sobre delegados de Prisma obliga a borrar los tipos, y borrar los
tipos justo en la capa cuya función es la corrección es un mal negocio. Cada
repositorio usa su delegado tipado y pasa su `where` por los dos ayudantes.

## Actualizar: `updateMany` en vez de `update`

```ts
async update(id: string, data: Prisma.ProjectUpdateInput): Promise<Project | null> {
  const { count } = await this.prisma.project.updateMany({ where: this.active({ id }), data });
  return count === 0 ? null : this.findById(id);
}
```

Esto parece un rodeo y es la línea más importante del archivo.

`update({ where: { id } })` en Prisma exige una clave única y **modificaría
felizmente la fila de otro cliente** si el atacante conoce el `id`. No se puede
añadir el `organizationId` al `where` de un `update` salvo que exista un índice
único compuesto.

`updateMany` acepta cualquier filtro: el `organizationId` forma parte de la
sentencia. Y `count` distingue "no existe" de "no es tuyo"... o mejor dicho, los
hace indistinguibles hacia fuera, que es justo lo que queremos: el servicio
convierte `null` en 404.

El test que lo cubre no es teórico:

```ts
// actuar como la organización A conociendo el id exacto de una fila de B
expect(await repository.update(otherOrgProjectId, { name: 'hacked' })).toBeNull();
```

## Borrado lógico

```ts
async softDelete(id: string): Promise<boolean> {
  const { count } = await this.prisma.project.updateMany({
    where: this.active({ id }),
    data: { deletedAt: new Date() },
  });
  return count > 0;
}
```

`active()` excluye lo ya borrado, así que borrar dos veces devuelve `false` en
lugar de reescribir la fecha. Las entradas de auditoría, los resultados de prueba
y las asignaciones de defectos siguen apuntando a una fila real.

## Reservar una clave legible sin colisiones

```ts
const project = await tx.project.update({
  where: { id: projectId, organizationId: this.organizationId },
  data: { [counter]: { increment: 1 } },
  select: { key: true, requirementCounter: true, testCaseCounter: true, defectCounter: true },
});

return `${project.key}-${infix}-${project[counter]}`;
```

Incremento y lectura en una sola sentencia (`UPDATE ... RETURNING`). Dos
peticiones simultáneas no pueden recibir el mismo número, cosa que
`SELECT max()+1` sí permitiría. Y recibe la transacción de quien llama, para que
la reserva se deshaga junto con la entidad que la motivó.

## Las tres excepciones, y por qué son excepciones

No todo repositorio puede heredar de `TenantAwareRepository`, porque hay
operaciones que ocurren **antes** de que exista un tenant. Están documentadas en
el propio archivo:

| Repositorio | Por qué no está scoped |
| --- | --- |
| `OrganizationsRepository` | `createWithOwner` crea el tenant; `listForUser` filtra por usuario |
| `OrganizationMembersRepository` | Es lo que *establece* el tenant: el guard lo consulta antes |
| `OrganizationInvitationsRepository` | La aceptación ocurre sin membresía previa; el token es la autorización |

Ninguna es una puerta trasera: reciben un `organizationId` que el guard ya
validó, o filtran por el usuario autenticado, o exigen un token de 256 bits.
Cuando se rompe una regla, se escribe *por qué* al lado.

## Comandos

```bash
# La prueba de aislamiento
cd apps/api && npx vitest run --config vitest.integration.config.ts test/tenancy.int-spec.ts

# Ver el SQL real que genera Prisma
LOG_LEVEL=debug npm run dev -w @qa-flow-hub/api
```

## Errores comunes

**Inyectar `PrismaService` en un servicio.** Es la vía por la que vuelve el
problema que el patrón resuelve. Revísalo en cada revisión de código.

**Usar `update`/`delete` por clave primaria.** Ver arriba. Es la fuga
cross-tenant más fácil de escribir sin darse cuenta.

**Aceptar `organizationId` como parámetro "por comodidad en los tests".** Si el
test necesita otra organización, que cambie el contexto.

**Repositorios anémicos.** Un repositorio que solo expone `findMany(where)` no
esconde nada: el `where` lo construye el servicio y volvemos al principio.

**Confundir repositorio con Data Mapper completo.** No hay identidad de objetos
ni unidad de trabajo. Prisma ya hace eso; encima solo añadimos la garantía de
tenant y nombres de dominio.

## Preguntas de repaso

1. ¿Por qué `organizationId` se coloca después del spread en `scope()`?
2. ¿Qué ataque concreto evita `updateMany` frente a `update`?
3. ¿Por qué `TenantAwareRepository` no ofrece CRUD genérico?
4. ¿Cómo garantiza `nextKey` que dos peticiones simultáneas no reciban el mismo
   número?
5. Nombra las tres excepciones al patrón y justifica cada una en una frase.

## Ejercicios

1. Escribe un repositorio para `Requirement` con `list` filtrado por proyecto,
   tipo y estado, sin aceptar `organizationId`.
2. Cambia `update` por `this.prisma.project.update({ where: { id } })` y ejecuta
   `tenancy.int-spec.ts`. Observa exactamente qué test se pone rojo.
3. Añade una regla ESLint que prohíba importar `PrismaService` fuera de
   `database/` y `*.repository.ts`.
4. Implementa `restore(id)` que revierta un borrado lógico y explica por qué
   `active()` no sirve ahí.

## Qué diría en una entrevista

> Los repositorios son la única capa con acceso a la base de datos, y en un
> producto multi-tenant son también el punto donde el filtro por organización se
> aplica siempre. La clase base inyecta `organizationId` en toda cláusula where y
> ningún método de repositorio lo acepta como argumento, así que no hay nada que
> olvidar. Las escrituras usan `updateMany` con el filtro de tenant en lugar de
> `update` por clave primaria, porque `update` modificaría la fila de otro
> cliente si alguien conoce el id; el número de filas afectadas distingue "no
> existe" de "no es tuyo" y ambos se devuelven como 404. Está cubierto por tests
> que actúan como una organización con los ids reales de otra.

## MVP frente a futuro

| Decisión | Ahora | Después |
| --- | --- | --- |
| Garantía de tenant | Aplicación, vía clase base | Añadir Row Level Security como segunda red |
| Regla "no Prisma en servicios" | Convención + revisión | Regla ESLint automática |
| Paginación | offset/limit | Cursores donde las listas crezcan |
| Consultas de lectura pesadas | Prisma | SQL crudo tipado si el plan lo pide |

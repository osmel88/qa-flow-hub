# 15 — Servicios y reglas de negocio

## Concepto

El servicio es donde vive la respuesta a "¿esto se puede hacer?". No valida
formatos —eso lo hizo Zod— ni comprueba roles de ruta —eso lo hizo el guard—:
decide si la operación es coherente con el estado actual del sistema.

La distinción es útil porque separa tres cosas que suelen mezclarse:

| Pregunta | Capa | Ejemplo |
| --- | --- | --- |
| ¿Está bien formado? | Pipe (Zod) | `key` tiene 2–8 caracteres |
| ¿Tiene permiso de ruta? | Guard | un `viewer` no llama a `POST /projects` |
| ¿Es coherente? | **Servicio** | esa clave ya existe en esta organización |

## Qué problema resuelve

Que las reglas estén en un solo sitio y sean legibles como prosa. En F3 hay
reglas cuya violación es irreversible o una escalada de privilegios, y ninguna es
expresable en un esquema ni en un decorador:

- una organización no puede quedarse sin `organization_owner`;
- nadie concede un rol superior al propio;
- una invitación se acepta exactamente una vez;
- un proyecto archivado no se edita.

## Archivos reales

```
apps/api/src/modules/organizations/organizations.service.ts   membresías y roles
apps/api/src/modules/organizations/invitations.service.ts     ciclo de invitación
apps/api/src/modules/projects/projects.service.ts             proyectos
apps/api/src/modules/auth/auth.service.ts                     credenciales
apps/api/src/errors/domain-error.ts                           vocabulario de fallos
```

## Regla 1 — jerarquía de roles

```ts
const ROLE_RANK: Record<OrganizationRole, number> = {
  organization_owner: 0,
  organization_admin: 1,
  project_manager: 2,
  qa_lead: 3,
  tester: 4,
  viewer: 5,
};
```

No es un sistema de permisos: es la respuesta a una sola pregunta, "¿puede esta
persona repartir ese rol?". Tres comprobaciones en `changeMemberRole`:

```ts
if (targetUserId === actor.userId) {
  throw new ForbiddenError('You cannot change your own role');
}
if (ROLE_RANK[role] < ROLE_RANK[actor.role]) {
  throw new ForbiddenError('You cannot grant a role more powerful than your own');
}
```

La segunda es la que impide que un `organization_admin` se fabrique un
`organization_owner` y acabe por encima de quien lo contrató. El guard no puede
hacerlo: el guard sabe que eres admin y que la ruta admite admins; no sabe qué
rol pretendes conceder.

La primera parece paternalista y no lo es: todos los casos legítimos de cambiar
tu propio rol (traspasar la propiedad) son operaciones de dos personas.

## Regla 2 — nunca cero propietarios

```ts
if (
  target.role === OrganizationRole.organization_owner &&
  role !== OrganizationRole.organization_owner &&
  (await this.members.countOwners(organizationId, targetUserId)) === 0
) {
  throw new ConflictError('The organization must keep at least one owner');
}
```

`countOwners(organizationId, excludeUserId)` cuenta los propietarios *que
quedarían*. Si son cero, la operación deja la organización sin nadie que pueda
administrarla, y eso no se arregla desde el producto: se arregla con soporte
tocando la base de datos. Es el tipo de estado que hay que hacer inalcanzable.

La misma regla está en `removeMember`. Dos rutas distintas, una invariante.

## Regla 3 — una invitación se consume una vez

La parte interesante es que la unicidad **no** se comprueba con un `if`:

```ts
async markAccepted(id: string, userId: string, tx: PrismaTransaction): Promise<boolean> {
  const { count } = await tx.organizationInvitation.updateMany({
    where: { id, status: InvitationStatus.pending },
    data: { status: InvitationStatus.accepted, acceptedAt: new Date(), acceptedByUserId: userId },
  });
  return count > 0;
}
```

El `status` está en el `WHERE`, no en un `if` previo. Con un `if` habría una
ventana entre leer y escribir; dos peticiones simultáneas con el mismo token
podrían pasar las dos. Aquí la base de datos decide, y la segunda obtiene
`count === 0`:

```ts
if (!(await this.invitations.markAccepted(invitation.id, userId, tx))) {
  throw new ConflictError('The invitation is no longer pending');
}
```

Esto es una comparación-y-escritura atómica escrita con un ORM. Aprende el
patrón: **el estado esperado va en el filtro de la actualización**.

## Regla 4 — el estado archivado significa algo

```ts
if (existing.status === ProjectStatus.archived) {
  throw new ConflictError('Restore the project before editing it');
}
```

Sin esta línea, "archivado" sería una etiqueta. Con ella es un estado: una
release cerrada no se edita sin reabrirla explícitamente, y la auditoría registra
esa reapertura.

## La invitación no es una membresía pendiente

Decisión de modelado que conviene entender, porque es la que más se suele
equivocar. Lo intuitivo sería `OrganizationMember` con `status = 'invited'`. No
funciona: **la persona invitada puede no tener cuenta**, y `OrganizationMember`
tiene `userId` obligatorio con clave foránea. No hay usuario al que apuntar.

Por eso `OrganizationInvitation` se identifica por email y solo se convierte en
membresía cuando alguien con cuenta la acepta. Y el email hace de puente:

```ts
if (invitation.email !== userEmail.trim().toLowerCase()) {
  throw new ConflictError('This invitation was issued for a different email address');
}
```

Sin esa comprobación, reenviar el enlace a un tercero le da acceso, y el admin
que invitó a un compañero habría incorporado a un desconocido.

## Un servicio no llama a Prisma

En todo `projects.service.ts` no aparece `this.prisma`. Solo
`this.projects.<método>`. La consecuencia práctica: **ningún método del servicio
recibe `organizationId`**, porque el repositorio lo saca del contexto. Un
argumento que no existe no se puede confundir.

La excepción consciente está en `invitations.service.ts`, que sí usa
`this.prisma` para dos lecturas y para abrir la transacción, porque la aceptación
ocurre *antes* de que exista una membresía y por tanto no hay tenant activo por
el que filtrar. Está comentado en el archivo; es la clase de excepción que se
documenta en lugar de esconderse.

## Errores de dominio, no excepciones HTTP

```ts
throw new ConflictError('The organization must keep at least one owner');
```

No `throw new HttpException(...)`. El servicio no sabe que existe HTTP, así que
el mismo código sirve para un consumidor de eventos o un comando de CLI. Un
único filtro traduce a estado HTTP. Ver el capítulo 19.

## Comandos

```bash
# Ejecutar solo las reglas de negocio de F3
cd apps/api && npx vitest run --config vitest.integration.config.ts test/organizations.int-spec.ts

# Ver la regla de propietario en acción
npm run db:seed
```

## Errores comunes

**Confiar en que el frontend no ofrecerá la opción.** Si "conceder propietario"
no está en el selector, alguien lo enviará con `curl`. Todas las reglas de este
capítulo tienen su test.

**Comprobar y luego escribir sin transacción ni filtro.** El patrón
`if (await exists()) { await update() }` tiene una ventana de carrera. Usa el
estado esperado en el `WHERE`.

**Mezclar reglas de negocio con autorización.** "Un admin puede cambiar roles" es
del guard. "Un admin no puede crear un propietario" es del servicio. Ponerlas
juntas hace ilegibles ambas.

**Silenciar fallos de operaciones compuestas.** En el registro con invitación, el
fallo de aceptación se propaga en lugar de tragarse: un usuario que se registró
desde un enlace y acabó sin organización vería un producto vacío sin explicación.

## Preguntas de repaso

1. ¿Por qué `ROLE_RANK` existe si ya hay un `RolesGuard`?
2. ¿Qué devuelve `countOwners(org, excludeUserId)` y por qué el parámetro de
   exclusión es imprescindible?
3. Explica por qué `markAccepted` pone `status` en el `WHERE` en lugar de
   comprobarlo antes.
4. ¿Por qué una invitación no puede ser un `OrganizationMember` con estado
   `invited`?
5. ¿Qué pasa si dos personas aceptan el mismo token en el mismo milisegundo?

## Ejercicios

1. Elimina temporalmente la comprobación de email en `accept()` y ejecuta la
   suite. Identifica qué test falla y qué ataque describe.
2. Implementa el traspaso de propiedad como operación explícita: promover a otro
   a propietario y degradarse uno mismo, atómicamente. Decide qué reglas de este
   capítulo deben relajarse y cuáles no.
3. Añade la regla "no se puede archivar un proyecto con una ejecución abierta".
   Escribe el test antes que el código.
4. Convierte `ROLE_RANK` en un permiso explícito (`canGrantRole(actor, target)`)
   y decide si el resultado es más legible o solo más indirecto.

## Qué diría en una entrevista

> Los servicios contienen las reglas cuya violación es irreversible: una
> organización sin propietario, una invitación aceptada dos veces, un admin que
> se fabrica un propietario. Ninguna es expresable en un esquema ni en un
> decorador de rol, porque dependen del estado actual. Donde hay concurrencia no
> uso comprobar-luego-escribir: pongo el estado esperado en el WHERE de la
> actualización y miro el número de filas afectadas, lo que convierte una carrera
> en un conflicto determinista. Y los servicios lanzan errores de dominio, no
> excepciones HTTP, así que la misma regla vale para un endpoint, una cola o un
> comando.

## MVP frente a futuro

| Decisión | Ahora | Después |
| --- | --- | --- |
| Jerarquía de roles | Tabla de rangos en el servicio | Motor de permisos si aparecen roles por cliente |
| Traspaso de propiedad | No implementado | Operación explícita de dos pasos |
| Eventos de dominio | El bus existe, se usa poco | Efectos secundarios (email, integraciones) por suscripción |
| Reglas por proyecto | El rol es de organización | Consultar `ProjectMember` (deuda registrada) |

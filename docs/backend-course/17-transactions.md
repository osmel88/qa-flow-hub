# 17 — Transacciones

## Concepto

Una transacción agrupa varias sentencias SQL en una unidad atómica: o se aplican
todas o no se aplica ninguna. En PostgreSQL cada sentencia suelta ya va en su
propia transacción implícita; lo que se decide aquí es **dónde poner los
límites** de las que abarcan varias.

## Qué problema resuelve

Estados imposibles que sobreviven a un fallo a mitad de camino. En F3 hay tres
que causarían soporte manual:

| Operación | Escribe en | Si falla a la mitad |
| --- | --- | --- |
| Crear organización | `organizations`, `organization_members` | Una organización sin propietario: nadie puede administrarla |
| Aceptar invitación | `organization_invitations`, `organization_members`, `audit_logs` | Token consumido sin acceso concedido, o acceso sin consumir el token |
| Crear requisito (F4) | `projects` (contador), `requirements` | Un hueco en la numeración o dos entidades con la misma clave |

La tercera es la más instructiva: el contador se incrementa aunque la entidad no
llegue a existir.

## Archivos reales

```
apps/api/src/database/prisma.service.ts                        runInTransaction, PrismaTransaction
apps/api/src/modules/organizations/organizations.repository.ts createWithOwner
apps/api/src/modules/organizations/invitations.service.ts      accept
apps/api/src/modules/audit/audit.service.ts                    record(entry, tx)
apps/api/src/modules/projects/projects.repository.ts           nextKey(..., tx)
```

## El tipo que hace posible componer

```ts
export type PrismaTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
```

Es un cliente Prisma sin los métodos que no tienen sentido dentro de una
transacción —incluido `$transaction`, porque anidar transacciones con Prisma no
hace lo que la gente espera—. Cualquier repositorio puede aceptar
`tx?: PrismaTransaction` y funcionar igual dentro y fuera:

```ts
const client = tx ?? this.prisma;
```

Sin este tipo, cada método tendría que duplicarse o aceptar `any`. Es el detalle
que permite que una operación compuesta reutilice los repositorios existentes en
lugar de escribir SQL a mano.

## Crear organización y propietario

```ts
async createWithOwner(
  data: { name: string; slug: string },
  ownerUserId: string,
  onCreated?: (organization: Organization, tx: PrismaTransaction) => Promise<void>,
): Promise<Organization> {
  return this.prisma.runInTransaction(async (tx) => {
    const organization = await tx.organization.create({ data });
    await tx.organizationMember.create({
      data: { organizationId: organization.id, userId: ownerUserId, role: 'organization_owner' },
    });
    await onCreated?.(organization, tx);
    return organization;
  });
}
```

El callback `onCreated` es la forma de que el servicio añada la entrada de
auditoría *dentro* de la misma transacción sin que el repositorio conozca el
módulo de auditoría. La dependencia va en la dirección correcta.

## Aceptar invitación: tres escrituras y una condición

```ts
return this.prisma.runInTransaction(async (tx) => {
  if (!(await this.invitations.markAccepted(invitation.id, userId, tx))) {
    throw new ConflictError('The invitation is no longer pending');
  }

  const existing = await this.members.findAnyMembership(userId, organization.id, tx);
  if (existing === null) {
    await this.members.create({ ... }, tx);
  } else {
    await this.members.reactivate(organization.id, userId, invitation.role, tx);
  }

  await this.audit.record({ action: 'accept_invite', ... }, tx);
  return { organizationId: invitation.organizationId, role: invitation.role };
});
```

Tres cosas que merecen atención.

**Todas las lecturas usan `tx`.** Leer con `this.prisma` dentro de un
`runInTransaction` abre una conexión distinta que no ve los cambios pendientes y
puede devolver un estado obsoleto. Es un error fácil de cometer y difícil de
diagnosticar, porque solo se nota bajo concurrencia.

**El `throw` es el mecanismo de rollback.** No hay `tx.rollback()`: si el
callback lanza, Prisma revierte. Lanzar un error de dominio y deshacer la
transacción son la misma acción.

**Reactivar en lugar de insertar.** Hay un índice único en
`(organizationId, userId)`, así que un miembro expulsado y reinvitado no puede
tener dos filas. El test lo comprueba contando filas después del ciclo completo.

## La auditoría dentro o fuera de la transacción

```ts
async record(entry: AuditEntry, tx?: PrismaTransaction): Promise<void>
```

Dos comportamientos deliberadamente distintos:

- **con `tx`**: si la auditoría falla, la operación entera se revierte. Un
  registro que afirma que algo pasó cuando la transacción se deshizo es peor que
  no tener registro, porque alguien lo creerá.
- **sin `tx`**: el fallo se registra en el log y no se propaga. La acción ya
  ocurrió; devolver un 500 por no poder anotarla convertiría un éxito en un error
  visible para el usuario.

## Qué NO envolver en una transacción

Una transacción mantiene bloqueos y una conexión del pool. Meter dentro
operaciones lentas es la causa habitual de agotamiento del pool bajo carga.

Fuera de la transacción, siempre:

- hashing de contraseñas (Argon2id tarda ~50 ms a propósito);
- llamadas HTTP a terceros (futuras integraciones con Jira);
- envío de emails;
- generación de tokens.

En `accept()`, la búsqueda de la invitación por hash y todas las validaciones
ocurren antes de abrir la transacción. Dentro solo quedan tres escrituras.

## Nivel de aislamiento

Se usa el de PostgreSQL por defecto, `READ COMMITTED`. No protege de anomalías de
escritura sesgada, y por eso las invariantes críticas no se apoyan solo en él:

- unicidad → índices únicos (incluido el parcial de invitaciones pendientes);
- consumo único → `updateMany` con el estado esperado en el `WHERE`;
- contadores → `UPDATE ... increment ... RETURNING`, no `SELECT max()+1`.

Si en el futuro una regla necesitara `SERIALIZABLE`, requeriría además lógica de
reintento ante errores de serialización. No es el caso hoy.

## Comandos

```bash
# Ver transacciones abiertas mientras corre la suite
docker compose exec postgres psql -U qaflow -d qa_flow_hub \
  -c "select pid, state, query from pg_stat_activity where state <> 'idle';"

# Los tests que dependen de atomicidad
cd apps/api && npx vitest run --config vitest.integration.config.ts test/organizations.int-spec.ts
```

## Errores comunes

**Leer con `this.prisma` dentro de una transacción.** Conexión distinta, datos
distintos. Si un método debe ser usable dentro de una transacción, tiene que
aceptar `tx`.

**Meter trabajo lento dentro.** Hashing o HTTP dentro de una transacción es cómo
se agota el pool en producción.

**Suponer que una transacción evita duplicados.** No los evita: los evita un
índice único. `READ COMMITTED` permite que dos transacciones lean "no existe" a
la vez.

**Capturar el error dentro del callback.** Si lo capturas y no relanzas, la
transacción hace commit del estado parcial.

**Transacciones interactivas largas.** `runInTransaction` con espera a una API
externa dentro es una transacción abierta a merced de la latencia ajena.

## Preguntas de repaso

1. ¿Por qué `PrismaTransaction` excluye `$transaction`?
2. ¿Qué estado inconsistente concreto evita `createWithOwner`?
3. ¿Por qué las lecturas dentro de `accept()` deben usar `tx`?
4. ¿Por qué `AuditService.record` se comporta distinto con y sin `tx`?
5. ¿Qué invariantes no dependen del nivel de aislamiento, y de qué dependen?

## Ejercicios

1. Quita el `tx` de una lectura dentro de `accept()` y razona en qué escenario
   concreto de concurrencia produciría un resultado erróneo.
2. Fuerza un fallo al final del callback de `createWithOwner` y comprueba en la
   base de datos que no queda ninguna organización.
3. Implementa "crear defecto desde un resultado fallido" (F7) en una transacción:
   reservar clave, crear defecto, enlazar trazabilidad, auditar.
4. Mide con `EXPLAIN ANALYZE` el coste de `nextKey` y compáralo con
   `SELECT max(...)+1`. Además del rendimiento, describe la diferencia de
   corrección.

## Qué diría en una entrevista

> Uso transacciones donde un fallo parcial dejaría un estado que solo se arregla
> a mano: crear una organización con su primer propietario, o aceptar una
> invitación, que consume el token, concede la membresía y escribe la auditoría.
> Los repositorios aceptan un cliente transaccional opcional, así que la misma
> operación compone dentro y fuera, y todas las lecturas dentro de la transacción
> usan ese cliente para no leer de otra conexión. Dejo fuera lo lento —hashing,
> HTTP— para no retener conexiones del pool. Y no confío en el nivel de
> aislamiento para la unicidad: eso lo garantizan índices únicos y
> actualizaciones condicionadas por el estado esperado.

## MVP frente a futuro

| Decisión | Ahora | Después |
| --- | --- | --- |
| Aislamiento | `READ COMMITTED` por defecto | `SERIALIZABLE` con reintentos si una regla lo exige |
| Efectos secundarios | Dentro, porque todo es local | Outbox transaccional cuando haya email o Jira |
| Reintentos | Ninguno | Reintento con backoff ante deadlock |
| Transacciones largas | Inexistentes | Trabajo por lotes en jobs, no en peticiones |

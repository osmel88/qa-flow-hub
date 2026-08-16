# 20 — Logging y auditoría

## Concepto

Son dos cosas distintas que se confunden a menudo:

| | Log | Auditoría |
| --- | --- | --- |
| Para quién | El operador | El cliente, un auditor, soporte |
| Pregunta | ¿Por qué falló? | ¿Quién hizo esto y cuándo? |
| Dónde | stdout → agregador | Tabla `audit_logs` |
| Retención | Días | Años |
| Se puede perder | Sí | No |
| Se consulta | Con `grep` | Con SQL, y se enseña en la UI |

Un log es diagnóstico. Una entrada de auditoría es **evidencia**, y en una
herramienta de QA es parte del producto: "quién cambió este caso antes de la
release" es una pregunta que un cliente hará.

## Qué problema resuelve

La auditoría resuelve tres cosas concretas para un SaaS B2B:

1. **Rendición de cuentas.** Alguien degradó a un usuario o archivó un proyecto;
   hay que poder decir quién.
2. **Cumplimiento.** SOC 2 e ISO 27001 piden registro de accesos y cambios. Un
   producto sin auditoría se queda fuera de compras corporativas.
3. **Soporte.** La mayoría de los "esto se ha borrado solo" se resuelven leyendo
   la tabla.

## Archivos reales

```
apps/api/src/modules/audit/audit.service.ts                  el servicio
apps/api/src/modules/audit/audit.module.ts                   global
apps/api/src/common/middleware/request-context.middleware.ts requestId, IP, user-agent
apps/api/src/database/tenant-context.service.ts              AsyncLocalStorage
apps/api/prisma/schema.prisma                                modelo AuditLog
```

## Lo que se registra, y por qué esas columnas

```prisma
model AuditLog {
  id             String      @id @default(uuid())
  organizationId String?
  userId         String?
  action         AuditAction
  entityType     String
  entityId       String
  summary        String
  changes        Json?
  ipAddress      String?
  userAgent      String?
  requestId      String?
  createdAt      DateTime    @default(now())
}
```

- `organizationId` y `userId` son opcionales porque hay acciones sin
  organización activa (login) o sin usuario (un futuro job del sistema).
- `entityType` es un `String`, no un enum: cada módulo nuevo añadiría un valor y
  una migración a cambio de nada.
- `summary` es la línea que se enseña en una lista sin tener que interpretar
  JSON. Es lo que hace la tabla usable por un humano.
- `changes` es JSONB con el antes/después estructurado, para filtrar en el
  futuro.
- `requestId` conecta la evidencia con los logs de diagnóstico de esa misma
  petición.

## El servicio

```ts
async record(entry: AuditEntry, tx?: PrismaTransaction): Promise<void> {
  const request = this.context.get();
  const organizationId =
    entry.organizationId === undefined ? (request?.organizationId ?? null) : entry.organizationId;

  await (tx ?? this.prisma).auditLog.create({
    data: {
      organizationId,
      userId: request?.userId ?? null,
      action: entry.action,
      /* ... */
      ipAddress: request?.ipAddress ?? null,
      userAgent: request?.userAgent ?? null,
      requestId: request?.requestId ?? null,
    },
  });
}
```

**Quién, desde dónde y en qué petición no los pasa quien llama: salen del
contexto.** Si el llamante los pasara, podría pasar los equivocados —o los de
otro usuario— y además cada llamada tendría cinco argumentos de ceremonia. El
`AsyncLocalStorage` los tiene desde el middleware.

El `organizationId` admite override explícito para el caso del login, donde no
hay organización activa pero sí hay algo que registrar.

## Append-only por ausencia... y por trigger

No hay `update()` ni `delete()` en `AuditService`. No es una convención escrita
en un README: es que los métodos no existen. Un registro que se puede editar no
es evidencia, y la forma más barata de garantizarlo en la capa de aplicación es
no ofrecer la operación.

Pero eso es una promesa sobre **nuestro código**, no sobre la base de datos:
cualquiera con las credenciales de la aplicación —una consola `psql`, un script,
un futuro camino de código que se olvide— podía borrar sus huellas. Así que la
regla vive también en PostgreSQL:

```sql
CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_append_only();
```

Tres detalles que se defienden solos:

1. **`TRUNCATE` necesita su propio trigger.** Los triggers de fila no lo ven, y
   es precisamente la forma más barata de borrarlo todo de una vez. Un guard que
   solo cubre `DELETE` invita a la única operación que no cubre.
2. **Trigger en vez de `REVOKE UPDATE, DELETE`.** La revocación de privilegios es
   más fuerte, pero exige un rol de aplicación que **no sea el propietario** de
   la tabla; con Prisma, ese mismo rol es el que ejecuta las migraciones. El
   trigger funciona hoy con el `DATABASE_URL` que ya existe; el rol dedicado va
   junto al trabajo de Row Level Security.
3. **Lo que el trigger NO impide:** el propietario de la tabla puede
   deshabilitarlo (`ALTER TABLE ... DISABLE TRIGGER`). Está escrito en
   `docs/technical-debt.md` en lugar de vendido como inmutabilidad absoluta — y
   el arnés de test hace exactamente eso para poder limpiar entre tests, lo que
   es la demostración honesta del límite.

El test se escribe con SQL crudo a propósito. Uno que pasara por la API solo
probaría que el método que decidimos no escribir no existe:

```ts
await expect(
  prisma.$executeRawUnsafe(`UPDATE audit_logs SET summary = 'nothing happened'`),
).rejects.toThrow(/append-only/);
```

## Dentro o fuera de la transacción

```ts
await this.audit.record({ ... }, tx);   // vive o muere con la operación
await this.audit.record({ ... });       // no puede tumbar la operación
```

Con `tx`, si la auditoría falla, la operación se revierte. Es lo que queremos
para "aceptó la invitación": una entrada que afirma algo que no ocurrió es peor
que ninguna entrada, porque alguien la creerá.

Sin `tx`, un fallo al escribir se registra en el log y no se propaga. La acción
ya ocurrió; convertirla en un 500 sería mentirle al usuario sobre el resultado.

El test que fija la primera mitad de esta regla:

```ts
expect(await prisma.auditLog.count({ where: { action: 'accept_invite' } })).toBe(0);
```

...después de una aceptación rechazada.

## Qué NO se registra

- contraseñas, hashes, tokens de refresco, tokens de invitación;
- el cuerpo completo de la petición;
- lecturas normales (un `GET` por fila haría crecer la tabla más rápido que los
  datos, y no responde a ninguna pregunta que alguien haga).

Se registran cambios de estado y acciones sensibles: `create`, `update`,
`delete`, `archive`, `restore`, `role_change`, `invite`, `revoke_invite`,
`accept_invite`, `login`, `logout`, `password_change`.

## El logging, brevemente

Pino a través de Nest, JSON en producción y legible en desarrollo, con
`requestId` en cada línea. Tres reglas:

1. Nunca registrar secretos ni PII innecesaria.
2. `error` es para lo que requiere acción humana; lo demás es `warn` o `info`.
   Si todo es error, nadie mira los errores.
3. Un log sin `requestId` es un log que no se puede correlacionar.

Y una elección explícita: los errores de dominio (4xx) **no** se registran como
`error`. Que un usuario mande una clave duplicada es funcionamiento normal.

## Comandos

```bash
# Últimas acciones de una organización
docker compose exec postgres psql -U qaflow -d qa_flow_hub -c \
  "select created_at, action, entity_type, summary from audit_logs order by created_at desc limit 20;"

# Todo lo ocurrido en una petición concreta
docker compose logs api | grep "$REQUEST_ID"
```

## Errores comunes

**Auditar desde el controlador.** El controlador no sabe si la operación tuvo
éxito ni qué cambió. La auditoría pertenece al servicio, junto a la escritura.

**Guardar el objeto completo en `changes`.** Acaba conteniendo `passwordHash` el
día que alguien pasa la entidad entera.

**Auditar lecturas.** Crecimiento sin uso. Si un cliente exige registro de
accesos, se hace por endpoint y de forma consciente.

**Usar la tabla de auditoría como fuente de verdad del estado.** Es un registro
de hechos, no un event store. Reconstruir el estado a partir de ella funciona
hasta el primer cambio de esquema.

**Un log por línea de código.** El coste de un log es la atención de quien lo
lee.

## Preguntas de repaso

1. Diferencia entre log y auditoría en una frase por columna de la tabla inicial.
2. ¿Por qué `AuditService` no expone `update` ni `delete`?
3. ¿Por qué `userId` e `ipAddress` no son parámetros del método `record`?
4. ¿Cuándo se pasa `tx` y qué cambia exactamente si no se pasa?
5. ¿Por qué `entityType` es `String` y no un enum de Prisma?

## Ejercicios

1. Añade auditoría a archivar y restaurar un proyecto incluyendo el estado
   anterior en `changes`, y escribe el test que lo comprueba.
2. Implementa `GET /audit?entityType=&action=&page=` con paginación y decide qué
   roles pueden verlo.
3. Escribe un test que recorra todas las entradas creadas por la suite y falle si
   alguna contiene una subcadena que parezca un token.
4. Crea un rol de aplicación que no sea propietario de `audit_logs`, dale solo
   `INSERT, SELECT`, y comprueba qué falla al arrancar y al migrar.

## Qué diría en una entrevista

> Separo diagnóstico de evidencia. Los logs son JSON estructurado con un
> requestId por petición y viven días; la auditoría es una tabla append-only que
> vive años y forma parte del producto, porque un cliente B2B preguntará quién
> cambió qué. El servicio de auditoría no tiene métodos de update ni delete: la
> inmutabilidad se garantiza por ausencia de la operación, y en la base de datos
> con triggers que rechazan `UPDATE`, `DELETE` y `TRUNCATE` —incluido `TRUNCATE`,
> que los triggers de fila no ven—. Lo más importante es que acepta el cliente
> transaccional: la entrada vive o muere con la operación que describe, porque un
> registro que afirma algo que se revirtió es peor que no tener registro. Y quién,
> desde dónde y en qué petición no los pasa el llamante, salen de un
> AsyncLocalStorage abierto en el middleware.

## MVP frente a futuro

| Decisión | Ahora | Después |
| --- | --- | --- |
| Inmutabilidad | Por ausencia de métodos | `GRANT INSERT, SELECT` sobre la tabla |
| Exposición | Solo tabla | Endpoint y pantalla con filtros (F8) |
| Retención | Sin política | Particionado por mes y archivado en frío |
| Transporte | Escritura síncrona | Outbox + consumidor si el volumen lo pide |
| Denegaciones | No se registran | Registrar 403 para detección de abuso |

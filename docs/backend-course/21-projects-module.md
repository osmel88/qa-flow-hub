# 21 — Módulo de organizaciones y proyectos

## Concepto

Este capítulo recorre el primer módulo funcional completo, de la ruta a la fila.
Todo lo que viene después —requisitos, suites, casos, ejecuciones, defectos—
repite exactamente esta estructura, así que conviene entenderlo una vez bien.

El módulo cubre dos agregados: la **organización** (con sus miembros e
invitaciones) y el **proyecto**.

## Qué problema resuelve

Es la puerta de entrada al producto. Sin organización no hay tenant; sin
invitaciones no hay equipo; sin proyecto no hay dónde colgar los casos de prueba.
También es donde se decide cómo entra la gente en el sistema, que es la parte con
consecuencias de seguridad.

## Archivos reales

```
apps/api/src/modules/organizations/
├── organizations.module.ts
├── organizations.controller.ts
├── organizations.service.ts               reglas de membresía y rol
├── invitations.service.ts                 ciclo de vida de la invitación
├── organizations.repository.ts
├── organization-members.repository.ts
├── organization-invitations.repository.ts
apps/api/src/modules/projects/
├── projects.module.ts
├── projects.controller.ts
├── projects.service.ts
└── projects.repository.ts
packages/shared/src/organizations/organization.contracts.ts
packages/shared/src/projects/project.contracts.ts
apps/api/test/organizations.int-spec.ts    41 tests
```

## Endpoints

```
POST   /api/v1/organizations                      crear (sin organización activa)
GET    /api/v1/organizations                      las mías, con mi rol
GET    /api/v1/organizations/invitations/preview  público, por token
POST   /api/v1/organizations/invitations/accept   autenticado, sin organización
GET    /api/v1/organizations/current
PATCH  /api/v1/organizations/current              owner
GET    /api/v1/organizations/current/members      paginado y con búsqueda
PATCH  /api/v1/organizations/current/members/:id  cambiar rol
DELETE /api/v1/organizations/current/members/:id  borrado lógico
POST   /api/v1/organizations/current/invitations
GET    /api/v1/organizations/current/invitations
POST   /api/v1/organizations/current/invitations/:id/resend
DELETE /api/v1/organizations/current/invitations/:id

POST   /api/v1/projects
GET    /api/v1/projects?status=&search=&page=&pageSize=
GET    /api/v1/projects/:id
PATCH  /api/v1/projects/:id
POST   /api/v1/projects/:id/archive
POST   /api/v1/projects/:id/restore
```

Tres rutas llevan `@SkipOrganization()`, y el motivo es el mismo en las tres: son
las operaciones mediante las cuales alguien *obtiene* una organización. Exigir
`X-Organization-Id` para crear tu primera organización sería un ciclo.

`/current` en vez de `/:organizationId` en la ruta: la organización activa ya
viaja en cabecera y está verificada por el guard. Ponerla también en la URL daría
dos fuentes de verdad y la tentación de fiarse de la equivocada.

## El ciclo de la invitación

```
        invite ─────────────► pending ──────► accepted   (membresía creada)
                                 │
                                 ├── resend ─► pending   (token NUEVO, el viejo muere)
                                 ├── revoke ─► revoked
                                 └── expira ─► expired
```

Cada transición, con su decisión:

**Invitar.** Antes de nada se llama a `expireOverdue()`. Sin eso, el índice único
parcial sobre `(organizationId, email) WHERE status = 'pending'` seguiría
rechazando una reinvitación legítima durante días, porque la fila caducada aún
figura como pendiente.

**Token.** 32 bytes aleatorios en `base64url` —43 caracteres seguros en una
URL— y en la base de datos solo `sha256(token)`. Sin sal, deliberadamente: con
256 bits de entropía no hay nada que romper por fuerza bruta, y un hash
determinista es lo que permite buscar la invitación por token sin recorrer la
tabla. Se compara con `timingSafeEqual`.

**Reenviar.** No reenvía nada (todavía no hay email): genera un token nuevo,
reinicia la caducidad y **mata el anterior**, porque el hash de la fila se
sobrescribe. Es la propiedad importante, y tiene test:

```ts
const withOldToken = await accept(first.token);   // 404
const withNewToken = await accept(resent.token);  // 200
```

**Aceptar.** Comprueba que el email de la invitación coincide con el del usuario
autenticado. Sin eso, reenviar el enlace a un tercero le da acceso.

**Revocar.** El token deja de servir de inmediato, y el mismo email puede
volver a invitarse: por eso el índice único es *parcial* y no total.

## Registro e invitación en una sola petición

```ts
if (input.invitationToken !== undefined) {
  await this.invitations.accept(input.invitationToken, user.id, user.email);
}
```

El usuario invitado no tiene cuenta: pulsa el enlace, ve la previsualización
pública, rellena el formulario de registro y entra ya dentro de la organización.
Dos peticiones separadas le pedirían pegar un token que nunca vio.

El fallo de la aceptación **no** se silencia. Si el token caducó entre el clic y
el envío del formulario, el usuario debe enterarse; la cuenta ya existe, así que
reintentar es un login.

## Proyectos: lo que hay que copiar en los módulos siguientes

```ts
async create(input: CreateProjectInput): Promise<ProjectView> {
  if ((await this.projects.findByKey(input.key)) !== null) {
    throw new DuplicateResourceError('project', 'key');
  }
  const project = await this.projects.create({ ... });
  await this.audit.record({ action: AuditAction.create, entityType: 'Project', ... });
  return toProjectView(project);
}
```

Cinco propiedades que se repetirán en F4–F7:

1. ningún método recibe `organizationId`;
2. la comprobación previa da un error legible, y el índice único da la garantía
   real bajo concurrencia;
3. la salida pasa por una función de proyección explícita;
4. las acciones importantes se auditan junto a la escritura;
5. las transiciones de estado son endpoints propios, no campos editables.

Sobre el punto 5: `PATCH /projects/:id` no acepta `status`. Archivar fija
`archivedAt`, y un proyecto archivado rechaza ediciones. Si `status` fuera un
campo cualquiera, "archivado" sería una etiqueta que no significa nada.

## El aislamiento, medido

```ts
it('lets a different organization use the same key', async () => { /* 201 */ });
it('hides another organization behind a 404, not a 403', async () => { /* 404 */ });
it('cuts a removed member off immediately, with their access token still in hand', async () => {
  // antes de expulsar: 200; después: 403, con el mismo token
});
```

El tercero es el que justifica una decisión de la fase anterior: la organización
activa no está en el JWT. Si lo estuviera, expulsar a alguien tardaría en surtir
efecto lo que dure su access token.

## Comandos

```bash
# Flujo completo a mano
TOKEN=$(curl -s -X POST localhost:3000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@acme.test","password":"Password123!"}' | jq -r .accessToken)
ORG=$(curl -s localhost:3000/api/v1/organizations -H "authorization: Bearer $TOKEN" | jq -r '.[0].id')

curl -s -X POST localhost:3000/api/v1/organizations/current/invitations \
  -H "authorization: Bearer $TOKEN" -H "x-organization-id: $ORG" \
  -H 'content-type: application/json' -d '{"email":"nuevo@acme.test","role":"tester"}' | jq

# Los 41 tests del módulo
cd apps/api && npx vitest run --config vitest.integration.config.ts test/organizations.int-spec.ts
```

## Errores comunes

**Modelar la invitación como una membresía pendiente.** No funciona: el invitado
puede no tener `userId`, y la clave foránea es obligatoria.

**Guardar el token en claro.** Quien lea la base de datos podría entrar en
cualquier organización con invitación abierta. Se guarda el hash, y el test lo
verifica.

**Índice único total en `(organizationId, email)`.** Impide reinvitar tras
revocar. Debe ser parcial sobre `status = 'pending'`.

**Insertar una membresía nueva al reaceptar.** Hay único en
`(organizationId, userId)`: al reincorporar a alguien expulsado hay que
reactivar la fila.

**Permitir que un admin cree un propietario.** Escalada de privilegios por
encima de quien administra. Lo impide `ROLE_RANK`.

**Dejar la organización sin propietario.** Estado que solo se arregla con
soporte.

## Preguntas de repaso

1. ¿Por qué tres rutas usan `@SkipOrganization()` y qué pasaría sin ellas?
2. ¿Por qué el índice único de invitaciones pendientes es parcial?
3. ¿Qué garantiza que un token de invitación se use una sola vez, y en qué capa?
4. ¿Por qué el registro acepta un token en lugar de exigir una segunda petición?
5. ¿Por qué archivar es `POST /:id/archive` y no `PATCH` con `status`?
6. ¿Cuánto tarda en surtir efecto la expulsión de un miembro, y por qué?

## Ejercicios

1. Implementa `GET /organizations/current/members/:userId` con su `*View` y su
   test de aislamiento.
2. Añade `POST /organizations/:id/leave` (abandonar la organización) respetando
   la regla del último propietario. Escribe primero los tests.
3. Implementa la caducidad de invitaciones como tarea programada en lugar de
   perezosa y razona qué gana y qué pierde frente a `expireOverdue()`.
4. Añade filtro por rol al listado de miembros, con paginación, sin tocar el
   servicio más de lo imprescindible.
5. Usando este módulo como plantilla, esboza el módulo de requisitos: contratos,
   repositorio, servicio, controlador y los seis primeros tests.

## Qué diría en una entrevista

> El módulo de organizaciones es donde se decide cómo entra la gente al producto,
> así que las decisiones son de seguridad más que de CRUD. La invitación es una
> entidad propia identificada por email, porque el invitado puede no tener
> cuenta; el token tiene 256 bits, se guarda solo hasheado, es de un solo uso y
> caduca, y reenviar lo sustituye en lugar de duplicarlo. La aceptación exige que
> el email del usuario coincida con el de la invitación, y consume el token,
> concede la membresía y escribe la auditoría en una transacción. El registro
> acepta el token para que registrarse y unirse sean una sola petición. Y las
> reglas de membresía —no conceder un rol superior al propio, no quedarse sin
> propietario— están en el servicio con tests, porque son las que no se pueden
> deshacer.

## MVP frente a futuro

| Decisión | Ahora | Después |
| --- | --- | --- |
| Envío de invitaciones | El token vuelve en la respuesta | Proveedor de email; el token deja de exponerse |
| Miembros de proyecto | El rol es de organización | `ProjectMember` consultado por los guards |
| Búsqueda de miembros | `ILIKE` sobre email y nombre | Índice trigram si crece |
| Archivado | Estado en la fila | Igual; el borrado real nunca es la operación por defecto |
| Plan de la organización | Campo informativo | Límites por plan y facturación |

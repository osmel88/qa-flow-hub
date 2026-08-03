# 12 — Autenticación

## Concepto

Autenticar es responder "¿quién eres?". Autorizar —capítulo 13— es responder
"¿puedes hacer esto?". Son cosas distintas y se implementan en sitios distintos.

## Qué problema resuelve

HTTP no tiene memoria. Cada petición llega sola y hay que decidir quién la
envía sin volver a pedir la contraseña. La solución clásica es intercambiar
credenciales una vez por un testigo (*token*) que acompaña a las siguientes.

Las decisiones difíciles no son "cómo hago un login", sino: qué pasa cuando
alguien roba el testigo, qué pasa cuando el usuario cierra sesión, y cuánto se
tarda en echar a alguien de verdad.

## Archivos reales

- [`auth.service.ts`](../../apps/api/src/modules/auth/auth.service.ts) — los flujos.
- [`password.service.ts`](../../apps/api/src/modules/auth/password.service.ts) — argon2id.
- [`token.service.ts`](../../apps/api/src/modules/auth/token.service.ts) — firma y hash.
- [`sessions.repository.ts`](../../apps/api/src/modules/auth/sessions.repository.ts) — rotación y revocación.
- [`guards/jwt-auth.guard.ts`](../../apps/api/src/modules/auth/guards/jwt-auth.guard.ts)
- [`auth.contracts.ts`](../../packages/shared/src/auth/auth.contracts.ts) — esquemas compartidos.
- [`test/auth.int-spec.ts`](../../apps/api/test/auth.int-spec.ts) — 21 pruebas.

## Decisión 1 — Argon2id, no bcrypt

```ts
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,  // 19 MiB
  timeCost: 2,
  parallelism: 1,
};
```

Una contraseña **nunca** se guarda; se guarda su hash. Pero no cualquier hash:
SHA-256 está diseñado para ser rápido, y eso es exactamente lo contrario de lo
que hace falta. Un algoritmo de contraseñas debe ser **caro a propósito**.

bcrypt sirve, pero es barato en GPU y trunca a 72 bytes. Argon2id es *duro en
memoria*: cada intento necesita 19 MiB, y eso encarece el paralelismo masivo en
GPU, que es como se crackea de verdad. Los parámetros son la línea base de
OWASP y son un compromiso explícito: más memoria encarece al atacante y también
cada login legítimo en nuestro servidor.

## Decisión 2 — El refresh token no es un JWT

```ts
issueRefreshToken(): IssuedRefreshToken {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: this.hashRefreshToken(token) };
}

hashRefreshToken(token: string): string {
  return createHmac('sha256', this.config.jwt.refreshSecret).update(token).digest('hex');
}
```

Un JWT se valida solo, sin consultar nada. Para un *access token* de quince
minutos eso es una ventaja. Para un refresh token de treinta días es un
defecto: **seguiría siendo válido después de que el usuario cierre sesión**. Y
como cada refresco tiene que escribir en la base de datos igualmente (hay que
rotar), el token no gana nada llevando claims.

Se guarda **HMAC-SHA256**, no el token. El secreto actúa de *pepper*: quien se
lleve una copia de la base de datos no puede usar los hashes sin robar además
el secreto de la aplicación. No usamos argon2 aquí porque la entrada son 256
bits aleatorios: no hay nada que adivinar.

## Decisión 3 — Rotación y detección de reuso

Cada refresco invalida el token recibido y emite otro de la misma **familia**.

```ts
if (session.revokedAt !== null) {
  const revoked = await this.sessions.revokeFamily(session.familyId, 'reuse_detected');
  throw new TokenReuseDetectedError();
}
```

Por qué importa: sin rotación, un refresh token robado da acceso durante treinta
días y nadie se entera. Con rotación, el token solo sirve una vez, así que
víctima y ladrón acaban compitiendo, y **el segundo en usarlo presenta un token
ya rotado**. Eso es la señal.

No podemos saber cuál de los dos es el ladrón, así que se revoca la familia
entera y ambos vuelven a autenticarse. Es una molestia pequeña a cambio de
convertir un robo silencioso en un evento detectado.

La rotación es **una transacción**:

```ts
return this.prisma.runInTransaction(async (tx) => {
  const created = await this.create({ ...previous, refreshTokenHash }, tx);
  await tx.session.update({ where: { id: previous.id }, data: { replacedById: created.id, revokedAt: new Date() } });
  return created;
});
```

Media rotación es un desastre en cualquiera de sus dos formas: revocar sin crear
echa al usuario, y crear sin revocar deja dos tokens vivos, que es justo lo que
la rotación existía para evitar.

## Decisión 4 — El guard consulta la sesión en cada petición

```ts
const session = await this.sessions.findById(payload.sid);
if (session === null || session.revokedAt !== null || session.userId !== payload.sub) {
  throw new UnauthenticatedError('The session is no longer valid');
}
```

Esto es una **lectura indexada por petición**, y es deliberado. La alternativa
purista —confiar solo en la firma— significa que "cerrar sesión en todos los
dispositivos" y "cambiar la contraseña" tardan hasta quince minutos en surtir
efecto. Para una herramienta de empresa eso no se sostiene en una revisión de
seguridad. Si algún día el coste importa, la mitigación conocida es una caché
de sesiones revocadas, no quitar la comprobación.

La prueba que lo fija:

```ts
it('stops accepting the access token as soon as its session is revoked', async () => {
  expect((await get('/api/v1/auth/me', bearer(session.accessToken))).statusCode).toBe(200);
  await post('/api/v1/auth/logout', { refreshToken: session.refreshToken });
  expect((await get('/api/v1/auth/me', bearer(session.accessToken))).statusCode).toBe(401);
});
```

## Decisión 5 — No revelar qué cuenta existe

Tres piezas trabajando juntas:

1. Un solo error, `InvalidCredentialsError`, para "correo desconocido" y
   "contraseña incorrecta".
2. `wasteTime()`, que verifica un hash ficticio cuando el correo no existe, para
   que **el tiempo de respuesta tampoco lo revele**. Sin esto, el desconocido
   responde en microsegundos y el real en decenas de milisegundos: eso es un
   oráculo perfectamente utilizable.
3. Bloqueo temporal tras varios fallos (`failedLoginAttempts`, `lockedUntil`),
   que devuelve `429` con `retryAfterSeconds`.

El registro es la excepción inevitable: si el correo ya existe, hay que decirlo,
porque el formulario no puede continuar. Se mitiga con rate limiting, no con un
mensaje ambiguo que rompa la experiencia.

## El flujo completo

```
POST /auth/register  → crea usuario (argon2id) + sesión → { accessToken, refreshToken, user, organizations }
POST /auth/login     → verifica, resetea contadores → mismo envelope
GET  /auth/me        → guard: verifica JWT + fila de sesión → perfil + organizaciones
POST /auth/refresh   → rota (transacción) → { accessToken, refreshToken }
POST /auth/logout    → revoca la sesión (idempotente)
POST /auth/change-password → verifica la actual, cambia, REVOCA TODAS las sesiones
```

El cambio de contraseña revocando todo no es celo excesivo: cambiar una
contraseña significa "creo que alguien la tiene". Dejar vivas las otras sesiones
haría el cambio decorativo.

## Comandos

```bash
docker compose up -d postgres
npm run dev -w @qa-flow-hub/api

curl -s -X POST localhost:3000/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.test","password":"Str0ngPassword!","fullName":"Ada"}' | jq

npm run test:integration -w @qa-flow-hub/api
```

## Errores comunes

- **Guardar el refresh token en claro.** Una copia de la base de datos pasa a
  ser una lista de sesiones utilizables.
- **JWT como refresh token.** El logout deja de funcionar de verdad.
- **Mensajes distintos** para usuario inexistente y contraseña incorrecta.
- **Olvidar el tiempo de respuesta.** El mensaje puede ser idéntico y aun así
  filtrar por el reloj.
- **Guardar el hash en el `SELECT` que devuelve el perfil.** Por eso existe
  `toPublicUser()`, y por eso es la única forma en que un usuario sale de la API.
- **Bloquear por IP en vez de por cuenta** (o solo por IP): NAT y móviles
  comparten IP.

## Preguntas de repaso

1. ¿Por qué argon2id y no SHA-256 con sal?
2. ¿Qué gana y qué pierde un refresh token opaco frente a un JWT?
3. ¿Qué significa exactamente presentar un token ya rotado?
4. ¿Por qué el guard consulta la base de datos si el JWT ya está firmado?
5. ¿Para qué sirve `wasteTime()`?

## Ejercicios

1. Quita la comprobación de la fila de sesión en el guard y ejecuta las pruebas.
   Anota cuál falla y por qué.
2. Cambia `memoryCost` a 64 MiB y mide el tiempo de login. Decide si lo
   aceptarías.
3. Implementa un endpoint `POST /auth/sessions/:id/revoke` para cerrar la sesión
   de otro dispositivo y escribe la prueba de que no puedes cerrar la de otra
   persona.

## Qué diría en una entrevista

> "Access token JWT corto y refresh token opaco guardado como HMAC. El refresh
> no es un JWT justamente porque un JWT sigue siendo válido después del logout,
> y como cada refresco tiene que rotar en base de datos de todas formas, el
> token no gana nada llevando claims. La rotación con familias convierte un robo
> de token en un evento detectable: el segundo que lo usa presenta uno ya
> rotado, y como no sé cuál de los dos es el ladrón, revoco la familia entera.
> Y el guard consulta la fila de sesión en cada petición: acepto una lectura
> indexada a cambio de que 'cerrar sesión en todas partes' sea inmediato."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Transporte del refresh | Cuerpo JSON | Cookie `HttpOnly` + `SameSite` con CSRF |
| Segundo factor | No | TOTP y códigos de recuperación |
| SSO | No | SAML/OIDC para clientes empresariales |
| Bloqueo | Por cuenta en PostgreSQL | Además por IP con almacén compartido |
| Recuperar contraseña | No (requiere email real) | Token de un solo uso, 30 minutos |

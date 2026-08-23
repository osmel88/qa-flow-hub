# 30 — Seguridad de la API

## Concepto

Los capítulos 12 y 13 cubrieron *quién eres* y *qué puedes hacer*. Este cubre
todo lo demás: qué llega al proceso, qué sale de él, qué puede leer un navegador
comprometido y qué averigua alguien que solo mide tiempos de respuesta.

La idea que ordena el capítulo: **la seguridad de una API son los valores por
defecto**. Un control que hay que recordar activar en cada endpoint ya falló;
solo falta saber en cuál.

## Qué problema resuelve

Un backend multi-tenant tiene un catálogo de fallos aburridos y caros:

| Amenaza | Sin control | Control aquí |
| --- | --- | --- |
| Un endpoint nuevo publicado sin autenticación | Fuga total | Guards **globales**; `@Public()` es la excepción |
| `{ "role": "owner" }` colado en un `PATCH /me` | Escalada de privilegios | Zod descarta claves desconocidas |
| XSS roba el refresh token de `localStorage` | Sesión de 30 días robada | Cookie `HttpOnly`, `SameSite=Strict` |
| Enumerar qué correos tienen cuenta | Lista para *credential stuffing* | Misma respuesta y **mismo tiempo** |
| Fuerza bruta contra una cuenta | Contraseña débil descubierta | Bloqueo persistido en la fila del usuario |
| Un 500 que enseña SQL o rutas del servidor | Reconocimiento gratis | Un solo filtro de excepciones |
| Un volcado de la base de datos | Credenciales de clientes | Hashes, HMAC y `secretRef`, nunca secretos |

## Archivos reales

```
apps/api/src/main.ts                              helmet, cors, cookie, rate limit
apps/api/src/modules/auth/guards/                 los tres guards globales
apps/api/src/common/pipes/zod-validation.pipe.ts  validación y saneado
apps/api/src/modules/auth/password.service.ts     argon2id y wasteTime()
apps/api/src/modules/auth/refresh-cookie.service.ts  dónde viaja el refresh token
apps/api/src/errors/all-exceptions.filter.ts      la única forma de una respuesta de error
docs/security-model.md                            el modelo de amenazas completo
```

## El orden de los plugins no es estético

```ts
// apps/api/src/main.ts
await app.register(import('@fastify/helmet'), { ... });
await app.register(import('@fastify/cookie'));
await app.register(import('@fastify/cors'), { origin: config.corsOrigins, credentials: true });
await app.register(import('@fastify/rate-limit'), { max, timeWindow });
```

Helmet va **primero** porque las cabeceras de seguridad deben estar también en
las respuestas que produce un plugin anterior al router de Nest. El caso concreto:
un `429` del limitador de peticiones no pasa por ningún controlador; si helmet se
registrase después, esa respuesta saldría sin `X-Content-Type-Options` ni
`X-Frame-Options`. Es un detalle pequeño y es exactamente el tipo de hueco que un
escáner de seguridad encuentra antes que tú.

`credentials: true` en CORS es obligatorio porque el refresh viaja como cookie, y
obliga a una lista explícita de orígenes: el navegador rechaza `Access-Control-
Allow-Origin: *` junto con credenciales. Eso convierte un descuido de
configuración en un error visible en desarrollo, no en una API abierta.

## Autenticado por defecto

```ts
// apps/api/src/modules/auth/auth.module.ts
{ provide: APP_GUARD, useClass: JwtAuthGuard },
{ provide: APP_GUARD, useClass: ActiveOrganizationGuard },
{ provide: APP_GUARD, useClass: RolesGuard },
```

Los guards son globales y `@Public()` es la excepción. Es la misma decisión que
`strict` en TypeScript: **el olvido debe romper, no publicar**. Con guards por
controlador, un endpoint nuevo sin decorador queda abierto y nada falla; con
guards globales, un endpoint que debía ser público devuelve `401` en el primer
test — un fallo ruidoso e inmediato.

El coste de esta postura está pagado en el capítulo 13: el guard de rol de las
rutas *project-scoped* falla abierto y el servicio decide, porque el proyecto solo
se conoce tras cargar la entidad. Está anotado como deuda, no escondido.

## El navegador no puede leer su propio refresh token

```ts
void reply.setCookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
  httpOnly: true,
  sameSite: 'strict',
  secure: this.config.isProduction,
  path: `/${this.config.apiPrefix}/v1/auth`,
  maxAge: parseDuration(this.config.jwt.refreshTtl),
});

return this.wantsBody(request) ? tokens : { ...tokens, refreshToken: null };
```

Cuatro decisiones en cinco líneas:

- **`httpOnly`**: un XSS puede hacer peticiones en tu nombre mientras la página
  está abierta, pero no puede **exfiltrar** una credencial de 30 días. La
  diferencia entre un incidente y una brecha persistente.
- **`sameSite: 'strict'`** y no `lax`: en este producto no hay ninguna navegación
  entre sitios que deba llegar autenticada, y `Strict` elimina el CSRF sobre el
  endpoint de refresco sin necesidad de tokens anti-CSRF.
- **`secure` solo en producción**: en desarrollo, sobre HTTP, el navegador
  descartaría la cookie en silencio y la sesión nunca se restauraría. Un fallo
  que parece un bug de la aplicación durante media tarde.
- **`path` limitado a `/auth`**: una cookie en `/` viajaría en todas las
  peticiones, incluidas las que no tienen nada que hacer con ella. Menos
  superficie y menos bytes.

Y `refreshToken: null` en la respuesta: el valor **no vuelve** al cliente que
tiene cookies. Quien necesita el cuerpo —la suite de integración, un script de
CI— lo pide con `X-Refresh-Transport: body`. El defecto es el seguro porque
olvidar la cabecera rompe un script, mientras que lo contrario devolvería el
token a todos los navegadores en silencio.

## Zod no valida: sanea

```ts
return this.schema.parse(value);
```

El pipe **sustituye** el valor por la salida del esquema, y ahí están dos
controles:

1. **Anti mass assignment.** Los objetos de Zod descartan claves desconocidas por
   defecto, así que un `PATCH /me` con `{ "role": "organization_owner" }` pierde
   ese campo *antes* de que ningún servicio lo vea. No hay una lista de campos
   prohibidos que mantener: lo que no está en el contrato no existe.
2. **Normalización.** `emailSchema` recorta y pasa a minúsculas, y el handler
   recibe el valor normalizado, de modo que no puede comparar por accidente el
   original. Sin esto, `Ana@X.com` y `ana@x.com` son dos cuentas.

## Lo que no se puede medir

```ts
async wasteTime(): Promise<void> {
  dummyHashPromise ??= argon2.hash('a-password-that-belongs-to-nobody', ARGON2_OPTIONS);
  await this.verify(await dummyHashPromise, 'not-the-password');
}
```

Si el correo no existe, `login` responde en microsegundos; si existe y la
contraseña falla, tarda las decenas de milisegundos de argon2id. Ese hueco es un
**oráculo de enumeración de cuentas** perfectamente usable a escala: no necesitas
adivinar contraseñas, solo saber qué direcciones tienen cuenta para venderlas o
atacarlas en otro sitio.

El control es gastar el mismo CPU en los dos caminos. Que el mensaje de error sea
idéntico es la mitad visible del control; la otra mitad es el reloj.

Argon2id y no bcrypt por dos razones concretas: bcrypt es barato en GPU y trunca
a 72 bytes. Argon2**id** es *memory-hard* —lo que hace caro el crackeo masivo
offline, no simplemente lento— y resiste canales laterales mejor que argon2i. Los
parámetros (19 MiB, 2 iteraciones, 1 hilo) son la línea base de OWASP y son un
intercambio explícito: subir la memoria encarece al atacante **y** cada login
propio.

`needsRehash` permite subir esos parámetros más adelante y rehashear en el
siguiente login correcto de cada usuario, sin forzar un reinicio de contraseñas.

## El bloqueo vive en la base de datos

`failedLoginAttempts` y `lockedUntil` son columnas de `users`, no un `Map` en
memoria. Un contador en memoria se reinicia con cada despliegue y no se comparte
entre instancias: con dos réplicas y un reinicio, el bloqueo es una sugerencia.
El limitador de peticiones tiene precisamente ese problema —es por instancia— y
está documentado como deuda con su disparador: un almacén compartido implica
Redis, que hoy está fuera de alcance.

## Los errores no cuentan nada

Un solo filtro global produce **una sola forma** de respuesta de error, y las
excepciones inesperadas se registran con su traza y se responden con un mensaje
genérico. Ni SQL, ni metadatos de Prisma, ni rutas del servidor. El `requestId`
viaja en la respuesta y en cada línea de log: el cliente puede citarlo en un
ticket sin que le hayamos contado nada del interior.

Detalle del producto que también es seguridad: un recurso de otra organización
responde **404, no 403**. Un 403 confirmaría que el `id` existe, que es
justamente lo que un atacante quiere saber.

## Comandos

```bash
# Cabeceras de seguridad reales
curl -sD - -o /dev/null localhost:3000/health

# Anti mass assignment: la clave sobrante desaparece
curl -s -X POST localhost:3000/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"a@b.test","password":"Sup3r-secret!","fullName":"A","role":"organization_owner"}'

# El navegador no recibe el valor del refresh token
curl -s -c /tmp/jar -X POST localhost:3000/api/v1/auth/login \
  -H 'content-type: application/json' -d '{"email":"...","password":"..."}' | jq .refreshToken
grep -i httponly /tmp/jar

# El límite de peticiones responde 429
for i in $(seq 1 200); do curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/health; done | sort | uniq -c
```

## Errores comunes

- **Registrar helmet después del limitador de peticiones.** Las respuestas `429`
  salen sin cabeceras de seguridad y no lo notas: nunca pasan por un controlador.
- **`sameSite: 'none'` para "que funcione en local".** Convierte el refresco en
  un endpoint vulnerable a CSRF a cambio de un problema de configuración de CORS
  que se arregla en el sitio correcto.
- **Devolver 403 en vez de 404 entre organizaciones.** Confirma la existencia del
  recurso.
- **Comparar contraseñas o tokens con `===`.** Para el refresh token se compara el
  HMAC almacenado; cualquier comparación de secretos debe ser de tiempo constante.
- **Registrar el cuerpo de la petición para depurar.** Es la forma más rápida de
  meter contraseñas en los logs, y hay un test que comprueba que la auditoría no
  contiene ni la contraseña ni el hash tras cambiarla.

## Preguntas de repaso

1. ¿Por qué los guards son globales y `@Public()` la excepción, y no lo contrario?
2. ¿Qué protege exactamente `HttpOnly` y qué **no** protege?
3. ¿Por qué `SameSite=Strict` sustituye a un token anti-CSRF en este producto?
4. ¿Qué dos cosas hace el pipe de Zod además de rechazar peticiones inválidas?
5. ¿Por qué un login contra un correo inexistente tiene que tardar lo mismo?
6. ¿Por qué el bloqueo por intentos fallidos está en la base de datos y el
   límite de peticiones no?
7. ¿Por qué 404 y no 403 al pedir un recurso de otra organización?

## Ejercicios

1. Cambia `httpOnly` a `false` y ejecuta el E2E. El test que recarga la página
   comprueba que ninguna credencial es alcanzable desde script: mira **cuál** de
   las aserciones falla y por qué. Deshaz.
2. Quita `@Public()` de `/health` y ejecuta la suite de integración. Observa que
   el fallo es inmediato y ruidoso; ese es el argumento a favor de los guards
   globales.
3. Elimina la llamada a `wasteTime()` y mide con `curl -w '%{time_total}'` un
   login contra un correo existente y otro inexistente. Anota la diferencia:
   acabas de construir el oráculo. Deshaz.
4. Añade un campo no declarado al cuerpo de `POST /projects` y comprueba en la
   base de datos que no llegó a ninguna parte.
5. Escribe un test que falle si un endpoint nuevo aparece sin `@Public()` y sin
   estar cubierto por los guards. Pista: `DiscoveryService` de Nest permite
   recorrer las rutas registradas.

## Qué diría en una entrevista

> "La postura es que la seguridad son los valores por defecto. Los guards son
> globales, así que un endpoint nuevo está autenticado sin que nadie se acuerde;
> Zod descarta lo que no está en el contrato, así que no hay lista de campos
> prohibidos que mantener; y el refresh token viaja en una cookie `HttpOnly` con
> `SameSite=Strict`, de modo que un XSS puede actuar mientras la pestaña está
> abierta pero no robar una credencial de 30 días.
>
> El detalle del que estoy más satisfecho es el menos visible: el login gasta el
> mismo CPU cuando el correo no existe. El mensaje idéntico es la mitad del
> control; sin igualar el tiempo, la API sigue contestando a la pregunta '¿tiene
> esta dirección una cuenta?'.
>
> Y sé lo que falta: no hay segundo factor, el límite de peticiones es por
> instancia y no hay recuperación de contraseña porque no hay envío de correo.
> Está escrito en `docs/security-model.md` con su disparador, porque un modelo de
> amenazas que solo enumera lo que sí hiciste no sirve para decidir qué hacer
> después."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Autenticación | JWT + refresh rotatorio en cookie | MFA (TOTP), SSO/SAML para empresa |
| Límite de peticiones | En memoria, por instancia | Almacén compartido (Redis) y límites por cuenta |
| Contraseñas | argon2id, bloqueo por cuenta | Recuperación por correo, comprobación contra listas filtradas |
| Cabeceras | helmet con CSP por defecto | CSP afinada con *nonces* para el frontend |
| Auditoría | Registra acciones | Registra también denegaciones y alerta sobre ráfagas de 403 |
| Secretos | `.env` y `secretRef` | Gestor de secretos real con rotación |
| Adjuntos | Solo metadatos | Subida firmada, antivirus, límites por tipo |

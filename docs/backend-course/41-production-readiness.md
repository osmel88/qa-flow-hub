# 41 — Production readiness: desplegable, operable y que falla cerrado

## Concepto

Que una aplicación "funcione" en local no dice nada sobre si se puede operar.
Producción añade preguntas que el código de negocio nunca se hace: ¿qué pasa si
alguien despliega con el secreto de ejemplo?, ¿cómo sabe el balanceador que una
instancia aún no puede servir?, ¿qué IP es la del cliente detrás de dos proxies?,
¿cómo encuentro en los logs la petición que falló a un usuario?, ¿puedo
restaurar la base de datos de anoche, y sigue aplicándose RLS después?

S2-F10 responde a esas preguntas **sin desplegar nada**: deja la plataforma lista
para que quien la despliegue no tenga que adivinar.

Código de referencia:

- `apps/api/src/config/env.schema.ts` — reglas de producción (`weakSecretReason`).
- `apps/api/src/bootstrap/configure-app.ts` — el pipeline HTTP compartido.
- `apps/api/src/bootstrap/request-id.ts`, `client-ip.ts` — correlación e IP.
- `apps/api/src/observability/app-logger.ts`, `http-metrics.ts` — logs y métricas.
- `apps/api/src/database/database-role.inspector.ts` — guardia del rol RLS.
- `apps/api/src/modules/health/readiness.service.ts` — readiness.
- `apps/api/src/database/migration-safety.ts`, `prisma/check-migrations.ts`.
- `apps/api/src/secrets/*` — puerto `SecretResolver` (ADR 0014).
- `scripts/db-backup.sh`, `scripts/restore-drill.sh`.
- `docs/deployment.md` — el runbook que acompaña al código.

## Fallar cerrado: la configuración como frontera de seguridad

`validateEnv` ya rechazaba un `CORS_ORIGINS=*` en producción (y ahora también
un `*` escondido dentro de una lista: `@fastify/cors` trata `['https://a', '*']`
como "cualquier origen"). Ahora, con
`NODE_ENV=production`, también rechaza:

| Configuración                                             | Por qué es peligrosa                                   |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `JWT_ACCESS_SECRET === JWT_REFRESH_SECRET`                | quien filtra uno puede firmar el otro tipo de token    |
| un secreto con `replace-me`, `replace-with`, `change-me`… | es el valor de `.env.example`, público en Git          |
| un secreto con menos de 10 caracteres distintos           | `'a'.repeat(32)` cumple la longitud y no es un secreto |
| `STORAGE_PROVIDER=memory`                                 | las evidencias desaparecen en cada reinicio            |
| `METRICS_ENABLED=true` sin `METRICS_TOKEN` fuerte         | `/metrics` describe el tráfico de todos los tenants    |

La idea clave: **un error de arranque es barato; una configuración insegura en
marcha es cara**. Un pod que no arranca se ve en el despliegue; un secreto de
ejemplo en producción no se ve hasta el incidente. Por eso estas reglas no son
warnings.

Fuera de producción las reglas extra no aplican: los tests y el desarrollo local
pueden usar valores triviales sin que eso sea una excusa en producción.

## La guardia del rol de base de datos

ADR 0013 separa dos credenciales: el owner (migraciones) y `qaflow_app`
(runtime). RLS **no se aplica al owner de la tabla**, ni a un superusuario, ni a
un rol con `BYPASSRLS`. Si alguien pone por error la URL del owner en
`DATABASE_URL`, todo sigue funcionando… y el aislamiento entre tenants deja de
existir sin un solo error.

`DatabaseRoleInspector` pregunta a PostgreSQL al arrancar:

```sql
SELECT current_user, rolsuper, rolbypassrls,
       EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public'
               AND pg_has_role(current_user, t.tableowner, 'MEMBER')) AS owns_tables,
       EXISTS (SELECT 1 FROM pg_roles p WHERE (p.rolsuper OR p.rolbypassrls)
               AND p.rolname <> current_user
               AND pg_has_role(current_user, p.oid, 'MEMBER')) AS assumes_privileged_role
FROM pg_roles WHERE rolname = current_user;
```

¿Por qué `pg_has_role` y no `tableowner = current_user`? La revisión final de
S2-F10 lo demostró: un rol `NOSUPERUSER NOBYPASSRLS` al que se le hace
`GRANT qaflow TO ...` no es el owner, pero **hereda** los privilegios del owner,
incluida la exención de RLS, y leía las 43 filas de `projects` sin contexto de
tenant. La primera versión de la consulta lo daba por seguro. Lo mismo con un
miembro de un rol `BYPASSRLS`: está a un `SET ROLE` de saltarse las políticas.

En producción, cualquiera de los cuatro problemas **detiene el arranque**. Fuera de
producción es un warning (las suites de integración se conectan como owner a
propósito) y readiness lo informa como `warn`.

Fíjate en el patrón: no confiamos en que el operador "lo sepa"; hacemos que el
sistema compruebe su propia premisa de seguridad.

## Un solo pipeline para producción y tests

Antes, `main.ts` registraba helmet, CORS, rate limiting y el request id, y el
harness de integración montaba su propia app sin la mitad de eso. Resultado:
los tests probaban una configuración que nadie ejecutaba (por eso el 429 salía
como 500 sin que ningún test lo viera).

Ahora ambos llaman a `configureApp(app, proxyTrust)`. La regla general: **si el
test arma la app a mano, tarde o temprano prueba otra app**.

`ProxyTrust` resuelve un problema de orden: el adapter de Fastify se crea antes
que el grafo de Nest, y la configuración validada existe después. `ProxyTrust`
es un objeto mutable que el adapter consulta en cada petición y que
`configureApp` rellena antes de aceptar la primera.

## ¿Quién es el cliente? `TRUST_PROXY`

`X-Forwarded-For` es una lista que cada proxy **amplía por la derecha**:

```text
X-Forwarded-For: <lo que escribió el cliente>, <lo que vio el CDN>, <lo que vio nginx>
socket: <IP de nginx>
```

Con `TRUST_PROXY=N` la IP del cliente es la entrada N posiciones desde la
derecha (contando el socket como posición 0). Lo que hay más a la izquierda lo
escribió el cliente y se ignora. Con `trustProxy: true` (lo que había antes) se
tomaba la primera entrada: cualquiera podía elegir su IP, y con ella su bucket de
rate limiting y lo que dice el audit log.

`resolveClientIp()` implementa la misma regla que Fastify usa para
`request.ip`, así que el rate limiter y la auditoría ven la misma dirección. Hay
un test de integración que lo comprueba: el cliente antepone una IP falsa y
sigue limitado.

## Rate limiting: por instancia, con un presupuesto para credenciales

Decisión aprobada (A, sin Redis):

- presupuesto global por IP (`RATE_LIMIT_*`);
- presupuesto más estricto, compartido por login, registro y refresh
  (`AUTH_RATE_LIMIT_*`), con clave `auth:<ip>`;
- el lockout por cuenta (S1) sigue siendo independiente;
- con N réplicas el límite efectivo es N veces el configurado; el límite global
  del clúster vive en el edge (nginx `limit_req`, reglas del CDN/WAF).

```ts
keyGenerator: (request) =>
  authRoutes.has(request.routeOptions.url ?? '') ? `auth:${request.ip}` : request.ip,
max: (_request, key) => (key.startsWith('auth:') ? auth.max : global.max),
```

`routeOptions.url` es la **plantilla** de ruta, no la URL concreta: así
`/auth/login?x=1` no escapa del presupuesto.

Un detalle que solo aparece con concurrencia: el store por defecto del plugin
le devuelve su **objeto contador vivo**, y el plugin lo lee después de un
`await`. Con 12 logins simultáneos y un presupuesto de 3, las 12 peticiones
leían `current = 12` y **todas** recibían 429, incluidas las tres legítimas.
`SnapshotRateLimitStore` devuelve una copia del valor en el momento de cada
incremento: exactamente 3 pasan y 9 reciben 429. Lección: un test secuencial no
prueba un contador compartido; hay que lanzar las peticiones con `Promise.all`.

El error del plugin ahora es un `RateLimitedError`, así que el filtro global
escribe el envelope estándar: `429 { error: { code: 'RATE_LIMITED', … } }` y
`Retry-After`.

## Request id: correlación sin inyección

Un `X-Request-Id` entrante se acepta solo si cumple `^[A-Za-z0-9._:-]{8,128}$`.
¿Por qué validar? Porque ese valor acaba en logs: un id con `\n` o comillas
permitiría inyectar líneas falsas. Si no es válido, se genera un UUID.

Fastify lo resuelve en `genReqId` y lo escribe de vuelta en la cabecera cruda,
para que el middleware de contexto (que ve la petición de Node, no la de
Fastify) llegue al mismo valor. Resultado: cabecera de respuesta, cuerpo de
error, cada línea de log y la fila de auditoría llevan el mismo id.

## Logs JSON y la línea por petición

En producción (`LOG_FORMAT=json`) cada línea es un objeto:

```json
{
  "time": "…",
  "level": "info",
  "context": "HTTP",
  "msg": "request completed",
  "requestId": "…",
  "method": "GET",
  "route": "/api/v1/projects/:id",
  "statusCode": 200,
  "durationMs": 12.4
}
```

Reglas:

- **ruta plantilla**, nunca la URL: la URL puede llevar ids y tokens en la query;
- nunca cabeceras ni cuerpos;
- claves que parecen credenciales (`authorization|cookie|password|secret|token|credential`)
  se redactan a cualquier profundidad, por si algún día alguien loguea un objeto
  de más;
- las sondas se loguean en `debug` para no ahogar el resto.

## Métricas sin cardinalidad infinita

`/metrics` (Prometheus) está apagado por defecto y en producción exige token.
Las etiquetas son solo `method`, `route` (plantilla) y `status`. Nunca un
`organizationId`, un `userId` o un `projectId`:

1. **Privacidad**: las métricas se envían a sistemas con otro control de acceso.
2. **Cardinalidad**: cada valor distinto de etiqueta es una serie nueva; con ids,
   la memoria de Prometheus crece con el número de entidades.

Las URLs que no casan con ninguna ruta se agrupan en `route="unmatched"` y los
métodos desconocidos en `OTHER`: el número de series lo acota la tabla de rutas.

## Liveness vs readiness

|                 | Pregunta                 | Si falla                  |
| --------------- | ------------------------ | ------------------------- |
| `/health`       | ¿el proceso responde?    | reiniciar                 |
| `/health/ready` | ¿puede servir **ahora**? | dejar de enviarle tráfico |

Si liveness dependiera de la base de datos, una caída de PostgreSQL haría que el
orquestador reiniciara **todas** las instancias en bucle, sin arreglar nada.

Readiness comprueba: `SELECT 1`, que todas las migraciones del disco estén
aplicadas y ninguna fallida, que el storage acepte escribir y borrar un objeto,
el resultado del chequeo de rol y si la instancia está drenando. Responde estados
(`ok`/`warn`/`fail`) y duraciones, **nunca mensajes de error**: el endpoint es
público y un mensaje de error de PostgreSQL revela host, usuario o versión.

Al ser público y escribir en storage, readiness también es un amplificador: 25
probes simultáneos eran 25 escrituras y 50 conexiones. Las peticiones que llegan
mientras un chequeo está en curso **esperan ese mismo chequeo** (_single
flight_: una promesa compartida en `inFlight`), así que un burst cuesta un solo
chequeo. No hay caché entre chequeos: cada probe posterior ve el estado real.

### Apagado ordenado

```text
SIGTERM → draining = true → /health/ready 503
       → esperar SHUTDOWN_GRACE_MS (el balanceador lo saca de rotación)
       → app.close(): deja de aceptar, termina lo que está en vuelo, cierra el pool
```

Sin la espera, las peticiones que el balanceador sigue enviando durante unos
segundos reciben "connection refused".

## Migraciones seguras

En un despliegue rolling, la versión vieja y la nueva conviven con **un** esquema.
`npm run db:migrations:check` (en CI) revisa el SQL de las migraciones nuevas y
rechaza `DROP TABLE/COLUMN`, renombrados, cambios de tipo, `SET NOT NULL`,
`TRUNCATE`, `DELETE` sin `WHERE` y todo lo que debilite RLS, salvo marcador
explícito con motivo:

```sql
-- migration-safety: allow drop-column: sin lecturas desde la release 1.4
```

Las migraciones ya aplicadas no se tocan (Prisma guarda su checksum): forman el
`REVIEWED_HISTORY`. Es una red, no un parser: no sustituye la revisión.

## Backup, restore y RLS

- El backup se hace como **owner**: un dump de `qaflow_app` estaría vacío, porque
  RLS sin tenant en sesión no devuelve filas.
- Los roles no están en el dump: un servidor nuevo necesita `qaflow_app` antes
  de que la API conecte.
- El drill restaura en una base temporal y comprueba checksum, migraciones,
  **que RLS cubre las mismas tablas con las mismas políticas que el origen** y
  los grants del rol de runtime. Un backup sin restore probado es una creencia.
- Las evidencias no están en la base de datos: se respaldan en la misma ventana.

RPO/RTO, retención y el runbook paso a paso están en `docs/deployment.md`.

## Secretos: un puerto, no una tabla

ADR 0014: las credenciales de integraciones viven en un secret manager externo;
la base de datos guarda solo `secretRef`. Hoy existe el puerto:

```ts
interface SecretResolver {
  resolve(secretRef: string, scope: { organizationId: string }): Promise<string | null>;
}
```

y un proveedor de entorno que solo lee `QAFLOW_SECRET_<ORG>_<NOMBRE>`. Las dos
restricciones evitan el _confused deputy_: `secretRef` es dato del tenant, y sin
ellas un tenant podría apuntar a `env:JWT_ACCESS_SECRET` o al token de otra
organización. Además, el id de organización debe ser alfanumérico: el segmento
termina en el primer `_`, así que una organización `ab-x` (normalizada como
`AB_X`) y la organización `ab` reclamarían la misma variable
`QAFLOW_SECRET_AB_X_TOKEN`. El proveedor real llega con GitHub Real.

## Cabeceras de seguridad

- API: CSP `default-src 'none'` — responde JSON, no necesita cargar nada.
- Web (nginx): scripts solo de `'self'`, `connect-src 'self'`, `blob:` para las
  previsualizaciones de evidencias, `frame-ancestors 'none'`, `nosniff`.
- `vite preview` envía las mismas cabeceras: el E2E corre bajo la CSP de
  producción, así que una violación rompe un test y no una release.
- Ojo con nginx: un `add_header` dentro de un `location` **anula** los heredados
  del `server`. Por eso las cabeceras viven en un snippet incluido en cada
  `location`.

## Cómo se prueba

- Unit: reglas de `validateEnv`, `weakSecretReason`, `resolveRequestId`,
  `resolveClientIp`, `JsonLogger` (redacción, niveles, correlación),
  `HttpMetrics` (etiquetas cerradas), `databaseRoleProblems`,
  `migration-safety`, `EnvSecretResolver` (aislamiento por organización).
- Integración (`health.int-spec.ts`, `production-readiness.int-spec.ts`):
  readiness 200/503 (DB, migraciones, storage, draining), cabeceras, CORS,
  request id, 413/415, rate limit con `Retry-After` y spoofing de IP, logs sin
  credenciales, métricas con token y sin ids, mismo id e IP en la auditoría.
- E2E: toda la suite corre bajo la CSP nueva.
- Scripts: backup + drill ejecutados contra la base de desarrollo.

## Preguntas de repaso

1. ¿Por qué liveness no consulta la base de datos?
2. ¿Qué entrada de `X-Forwarded-For` se usa con `TRUST_PROXY=2` y por qué no la primera?
3. ¿Por qué el arranque falla con el rol owner, si "todo funciona"?
4. ¿Qué dos problemas causa poner `organizationId` como etiqueta de métrica?
5. ¿Por qué el backup no se puede hacer con `qaflow_app`?
6. ¿Qué impide que un tenant use `env:DATABASE_URL` como `secretRef`?

## Ejercicios

1. Añade `nodejs_eventloop_lag_seconds` con `monitorEventLoopDelay` de `perf_hooks`.
2. Cachea el resultado de readiness 1 s y escribe el test que lo justifica.
3. Programa `db-backup.sh` + `restore-drill.sh` en un workflow nocturno de CI
   contra una base efímera.
4. Añade la regla `create-index-without-concurrently` a `migration-safety`.

## Qué diría en una entrevista

"La aplicación falla cerrada: en producción no arranca con secretos de ejemplo,
storage en memoria o un rol de base de datos que se salte RLS. Liveness y
readiness están separados; readiness comprueba base de datos, migraciones,
storage y rol, y pasa a 503 al recibir SIGTERM para drenar sin errores. Cada
petición tiene un id validado que aparece en cabecera, logs, errores y
auditoría; los logs son JSON con la ruta plantilla y sin credenciales, y las
métricas Prometheus solo tienen etiquetas de cardinalidad acotada. El rate
limiting es por instancia por decisión, con un presupuesto más estricto para
credenciales y el límite global en el edge."

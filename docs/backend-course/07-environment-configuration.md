# 07 — Configuración y entorno

## Concepto

La configuración es todo lo que cambia entre entornos: la cadena de conexión, los
secretos JWT, los orígenes CORS permitidos, los límites de peticiones. En este
backend la configuración tiene tres propiedades que no son negociables:

1. **Se valida al arrancar**, con Zod, y el proceso no levanta si algo falta.
2. **Se accede con tipos**, a través de una fachada, nunca con
   `process.env['ALGO']` esparcido por el código.
3. **Nunca se commitea**. `.env` está en `.gitignore`; `.env.example` documenta
   cada variable.

## Qué problema resuelve

El fallo clásico: `JWT_ACCESS_SECRET` no está definido, el proceso arranca
tranquilamente, y el primer login firma un token con `undefined`. Se descubre en
producción, en el peor momento, con un error que no menciona la variable.

Validar al arranque convierte ese fallo en un mensaje inequívoco antes de servir
la primera petición:

```
Invalid environment configuration:
  - JWT_ACCESS_SECRET: JWT_ACCESS_SECRET must be at least 32 characters
  - DATABASE_URL: Invalid url
```

## Archivos reales

- [`apps/api/src/config/env.schema.ts`](../../apps/api/src/config/env.schema.ts)
  — el esquema y la función de validación.
- [`apps/api/src/config/app-config.service.ts`](../../apps/api/src/config/app-config.service.ts)
  — la fachada tipada.
- [`apps/api/src/config/config.module.ts`](../../apps/api/src/config/config.module.ts)
  — módulo global.
- [`.env.example`](../../.env.example) — plantilla documentada.

## Código real

El esquema declara tipos, valores por defecto y **reglas de negocio de
seguridad**:

```ts
// apps/api/src/config/env.schema.ts
JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
```

Son **dos secretos distintos** a propósito: filtrar el de acceso no debe permitir
a un atacante emitir tokens de refresco, que son los de vida larga.

Las variables numéricas se declaran con `coerce`, porque en el entorno todo es
cadena:

```ts
PORT: z.coerce.number().int().min(1).max(65535).default(3000),
```

Y algunas se transforman a su tipo útil:

```ts
SWAGGER_ENABLED: z.enum(['true', 'false']).optional(),
```

Su valor por omisión no es una constante, sino el entorno: `/docs` publica la
superficie completa de la API, así que se enciende en desarrollo y se apaga en
producción, y un valor explícito gana en los dos sentidos.

```ts
.transform((env) => ({
  ...env,
  SWAGGER_ENABLED:
    (env.SWAGGER_ENABLED ?? (env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true',
}))
```

El mismo esquema rechaza además una combinación que nadie escribe a propósito
pero que aparece copiando configuración de desarrollo:

```ts
if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.trim() === '*') {
  // CORS se registra con `credentials: true`
}
```

**Decisión:** una comprobación cruzada entre dos variables no cabe en el
`z.object`, porque cada campo se valida por separado; vive en `superRefine`,
que ve el objeto entero. Y el sitio correcto es el arranque: un origen
comodín descubierto por una auditoría es mucho más caro que un despliegue que
no arranca.

La validación se engancha a `@nestjs/config`:

```ts
// apps/api/src/config/config.module.ts
NestConfigModule.forRoot({
  isGlobal: true,
  cache: true,
  ignoreEnvFile: process.env['NODE_ENV'] === 'production',
  envFilePath: ['.env.local', '.env'],
  validate: validateEnv,
})
```

`ignoreEnvFile` en producción es deliberado: allí las variables las inyecta la
plataforma, y un `.env` olvidado dentro de una imagen no debe ganarle a la
configuración real.

La fachada convierte cadenas en valores de dominio. Por ejemplo, CORS:

```ts
// apps/api/src/config/app-config.service.ts
get corsOrigins(): string[] | true {
  const raw = this.get('CORS_ORIGINS').trim();
  if (raw === '*') return true;
  return raw.split(',').map((o) => o.trim()).filter((o) => o.length > 0);
}
```

El consumidor recibe algo que puede pasar directamente al plugin de CORS. Esa
transformación ocurre **una vez y en un sitio**; si estuviera en `main.ts`, se
repetiría en cuanto hiciera falta en otro punto.

Y el genérico que da tipos a todo:

```ts
private get<K extends keyof Env>(key: K): Env[K] {
  return this.config.get(key, { infer: true });
}
```

## El fichero `.env.example`

No es una lista de nombres: explica y agrupa. Incluye incluso el comando para
generar secretos:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Y documenta por qué hay tres conexiones:

```
DATABASE_URL=postgresql://qaflow_app:...@localhost:5432/qa_flow_hub?schema=public
DATABASE_MIGRATION_URL=postgresql://qaflow:qaflow@localhost:5432/qa_flow_hub?schema=public
TEST_DATABASE_URL=postgresql://qaflow:qaflow@localhost:5433/qa_flow_hub_test?schema=public
```

Las dos primeras apuntan a la **misma** base de datos con roles distintos:
`qaflow_app` no es propietario de ninguna tabla, y por eso las políticas de Row
Level Security se le aplican (el capítulo 10 lo explica). Las migraciones y el
seed necesitan el propietario.

El puerto 5433 es la base de datos de pruebas. Existe para que ejecutar la suite
de integración —que trunca tablas— **no borre los datos con los que estás
trabajando**. Es una separación barata que evita una pérdida de tiempo real.

## Variables actuales

| Variable | Para qué | Por defecto |
| --- | --- | --- |
| `NODE_ENV` | Modo de ejecución | `development` |
| `PORT`, `HOST` | Escucha HTTP | `3000`, `0.0.0.0` |
| `API_PREFIX` | Prefijo global | `api` |
| `LOG_LEVEL` | Verbosidad | `info` |
| `DATABASE_URL` | Conexión PostgreSQL | — (obligatoria) |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Firma de tokens | — (obligatorias, ≥32) |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | Vigencia | `15m` / `30d` |
| `CORS_ORIGINS` | Orígenes permitidos | `http://localhost:5173` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | Límite de peticiones | `300` / `60000` |
| `AUTH_MAX_FAILED_ATTEMPTS` / `AUTH_LOCKOUT_MINUTES` | Fuerza bruta | `5` / `15` |
| `INVITATION_TTL_DAYS` | Caducidad de invitaciones | `7` |
| `WEB_BASE_URL` | Base de los enlaces de invitación | `http://localhost:5173` |
| `SWAGGER_ENABLED` | Publicar `/docs` | `true`, salvo `production` → `false` |

## Comandos

```bash
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
npm run dev -w @qa-flow-hub/api

# Comprobar que un entorno inválido no arranca
JWT_ACCESS_SECRET=corto node apps/api/dist/main.js
```

## Errores comunes

- **Añadir una variable y usarla sin declararla en el esquema.** Con
  `noPropertyAccessFromIndexSignature` no compila, que es justo lo que quieres.
  Declárala en `env.schema.ts` y expónla en la fachada.
- **Commitear `.env`.** `.gitignore` lo bloquea; verifica con
  `git check-ignore -v .env`. Si un secreto llega a llegar al historial,
  rotarlo es obligatorio: borrar el commit no basta.
- **Poner secretos en `docker-compose.yml`.** El fichero los **exige** pero no
  los contiene: `${JWT_ACCESS_SECRET:?set JWT_ACCESS_SECRET in your .env}` falla
  con un mensaje claro si no están en tu `.env`.
- **Usar `*` en `CORS_ORIGINS` con credenciales.** El navegador lo rechaza y,
  aunque no lo hiciera, sería un agujero. `*` solo para desarrollo local: en
  producción el esquema no arranca, con el mensaje
  `CORS_ORIGINS cannot be "*" in production`.
- **Dejar `/docs` abierto en producción.** Ya no ocurre por omisión, pero
  `SWAGGER_ENABLED=true` heredado de un `.env` de desarrollo sí lo reabre.

## Preguntas de repaso

1. ¿Qué ocurre exactamente si `DATABASE_URL` no es una URL válida, y en qué
   momento?
2. ¿Por qué hay dos secretos JWT en vez de uno?
3. ¿Por qué se ignora el fichero `.env` en producción?
4. ¿Qué aporta `AppConfigService` frente a inyectar `ConfigService`?

## Ejercicios

1. Añade `MAX_UPLOAD_MB` (entero, entre 1 y 100, por defecto 25): al esquema, a
   la fachada y a `.env.example`. Escribe el test unitario correspondiente en
   `env.schema.test.ts`.
2. Arranca la API con `JWT_REFRESH_SECRET` de 10 caracteres y copia el mensaje
   de error exacto.
3. Cambia `CORS_ORIGINS` a un origen que no sea el del frontend y observa el
   fallo desde el navegador. Explica qué cabecera falta.

## Qué diría en una entrevista

> "Valido el entorno con Zod en el arranque, de modo que un secreto ausente o
> una URL mal formada tumban el proceso con un mensaje que nombra la variable,
> en lugar de fallar tres capas más abajo durante un login. El acceso pasa por
> una fachada tipada, así que no hay `process.env` repartido por el código y las
> transformaciones —por ejemplo, la lista de orígenes CORS— ocurren en un único
> sitio."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Secretos | Variables de entorno | Gestor de secretos (Vault, AWS Secrets Manager) con rotación |
| Configuración por organización | No existe | Ajustes por tenant en base de datos, no en el entorno |
| Feature flags | No | Necesarios en cuanto haya clientes con distinto ritmo de despliegue |

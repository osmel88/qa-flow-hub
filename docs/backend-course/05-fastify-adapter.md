# 05 — El adaptador Fastify

## Concepto

NestJS no implementa el servidor HTTP: lo abstrae. Por defecto usa Express;
aquí usa **Fastify** mediante `@nestjs/platform-fastify`. El código de los
controladores es idéntico en ambos casos —esa es la ventaja del adaptador—, pero
cambia lo que hay debajo: el enrutador, el sistema de plugins y la
serialización.

## Qué problema resuelve

Fastify aporta tres cosas concretas a este proyecto:

1. **Rendimiento**: enrutado por *radix tree* y serialización JSON compilada.
   Aproximadamente el doble de peticiones por segundo que Express en cargas
   típicas de API.
2. **Un sistema de plugins con encapsulación**: `helmet`, `cors` y `rate-limit`
   se registran como plugins con un orden explícito, no como middleware
   apilado por convención.
3. **Utilidades de prueba de primera clase**: `app.inject()` ejecuta una
   petición contra la aplicación **sin abrir un socket**, lo que hace los tests
   de integración rápidos y deterministas.

**Decisión.** El coste real de elegir Fastify no es técnico sino de ecosistema:
algunos paquetes de Nest asumen Express y hay que instalar equivalentes. Nos
pasó de inmediato: la interfaz de Swagger falla con
`The "@fastify/static" package is missing` hasta que se instala ese plugin. Ver
[`../adr/0002-fastify-adapter.md`](../adr/0002-fastify-adapter.md).

## Archivos reales

- [`apps/api/src/main.ts`](../../apps/api/src/main.ts) — adaptador y plugins.
- [`apps/api/src/errors/all-exceptions.filter.ts`](../../apps/api/src/errors/all-exceptions.filter.ts)
  — usa `FastifyReply`/`FastifyRequest`, no los tipos de Express.
- [`apps/api/test/utils/create-test-app.ts`](../../apps/api/test/utils/create-test-app.ts)
  — arranque para pruebas, con `.ready()`.

## Código real

Registro de plugins, en el orden en que importan:

```ts
// apps/api/src/main.ts
await app.register(import('@fastify/helmet'), {
  contentSecurityPolicy: config.isProduction ? undefined : false,
});

await app.register(import('@fastify/cors'), {
  origin: config.corsOrigins,
  credentials: true,
  exposedHeaders: ['X-Request-Id'],
});

await app.register(import('@fastify/rate-limit'), {
  max: config.rateLimit.max,
  timeWindow: config.rateLimit.windowMs,
});
```

Por qué ese orden: **helmet primero**, para que las cabeceras de seguridad estén
presentes incluso en las respuestas que genera el propio limitador de peticiones
(un 429 también debe llevar `X-Content-Type-Options`). CORS después, porque
necesita responder a `OPTIONS` antes de que la petición llegue al router. Y el
rate limit al final de la cadena de seguridad, ya con las cabeceras puestas.

La CSP se desactiva fuera de producción a propósito: la interfaz de Swagger
carga scripts en línea y con CSP estricta no se puede usar en local.

Respuesta desde el filtro de excepciones, con la API de Fastify:

```ts
// apps/api/src/errors/all-exceptions.filter.ts
const reply = http.getResponse<FastifyReply>();
void reply.status(normalised.status).send(body);
```

En Express sería `res.status(...).json(...)`. Es exactamente el tipo de detalle
que el adaptador **no** oculta: en cuanto tocas el objeto de respuesta nativo,
estás acoplado al servidor concreto.

Pruebas sin red:

```ts
// apps/api/test/health.int-spec.ts
const response = await app.inject({ method: 'GET', url: '/health' });
expect(response.statusCode).toBe(200);
```

Y el arranque de pruebas necesita una línea que sorprende la primera vez:

```ts
// apps/api/test/utils/create-test-app.ts
await app.init();
await app.getHttpAdapter().getInstance().ready();
```

`ready()` espera a que **todos los plugins de Fastify hayan terminado de
registrarse**. Sin esa línea, los tests fallan de forma intermitente porque las
rutas todavía no están montadas: un fallo que parece flaky y no lo es.

## Verificación manual

Las cabeceras que pone helmet, comprobadas contra la API en marcha:

```bash
curl -s -i http://localhost:3000/health | head -12
```

```
HTTP/1.1 200 OK
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
```

## Comandos

```bash
npm run dev -w @qa-flow-hub/api
curl -s -i http://localhost:3000/health
curl -s http://localhost:3000/api/v1/nope | jq        # sobre el formato de error
npm run test:integration -w @qa-flow-hub/api
```

## Errores comunes

- **`The "@fastify/static" package is missing`.** Lo lanza `SwaggerModule` al
  servir su interfaz. Se resuelve instalando `@fastify/static` en la API. Es el
  ejemplo canónico del coste de no usar Express.
- **Tipar `@Res()` como `Response` de Express.** Compila si tienes los tipos de
  Express en el proyecto y falla en ejecución. Usa `FastifyReply`.
- **Olvidar `.ready()` en las pruebas.** Tests intermitentes con 404.
- **Registrar plugins después de `listen()`.** Fastify lanza
  `FST_ERR_INSTANCE_ALREADY_LISTENING`.
- **Suponer que el límite de peticiones es global.** El almacén está en memoria:
  con dos instancias, el límite efectivo se duplica. Documentado en
  [`../technical-debt.md`](../technical-debt.md).

## Preguntas de repaso

1. ¿Qué cambia y qué no cambia en tu código al pasar de Express a Fastify?
2. ¿Por qué helmet se registra antes que el limitador de peticiones?
3. ¿Qué hace `app.inject()` y por qué es preferible a levantar un servidor real
   en las pruebas?
4. ¿Por qué la CSP está desactivada fuera de producción?

## Ejercicios

1. Baja `RATE_LIMIT_MAX` a 3, reinicia y lanza cinco peticiones seguidas.
   Observa el 429 y comprueba que el cuerpo sigue el formato `{ error: ... }`
   con código `RATE_LIMITED`.
2. Añade el plugin `@fastify/compress` y mide el tamaño de una respuesta grande
   con y sin él.
3. Escribe un test que compruebe que la cabecera `X-Content-Type-Options` está
   presente también en una respuesta 404.

## Qué diría en una entrevista

> "Uso el adaptador de Fastify porque el código de Nest no cambia y ganamos
> rendimiento y un sistema de plugins con orden explícito. El coste es de
> ecosistema: hay paquetes que asumen Express, y lo pagamos el primer día
> instalando `@fastify/static` para que funcionase la interfaz de OpenAPI. En
> las pruebas, `inject()` permite ejercitar la aplicación completa sin abrir
> sockets, lo que hace la suite de integración rápida y determinista."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Rate limit | En memoria, por instancia | Almacén compartido cuando haya varias réplicas |
| Logs | `Logger` de Nest | Logger de Fastify (pino) con salida JSON estructurada |
| Compresión | No | `@fastify/compress` para respuestas grandes de la matriz |

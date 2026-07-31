# 02 — El runtime de Node.js

## Concepto

Node.js ejecuta JavaScript fuera del navegador sobre el motor V8, con un **bucle
de eventos** de un solo hilo y una biblioteca de E/S asíncrona (libuv). Todo lo
que hace lento a un backend —leer disco, hablar con PostgreSQL, llamar a una
API— no bloquea ese hilo: se delega y se continúa cuando la respuesta llega.

Este proyecto fija **Node.js 24**: en [`.nvmrc`](../../.nvmrc), en
[`package.json`](../../package.json) (`engines`), en los `Dockerfile` y en el
workflow de CI. Los cuatro sitios deben coincidir; si divergen, tendrás un bug
que solo se reproduce en producción.

## Qué problema resuelve

Un servidor tradicional con un hilo por conexión gasta memoria y cambios de
contexto en peticiones que están *esperando*. Un backend de API pasa la mayor
parte del tiempo esperando a la base de datos. El modelo de Node cambia esa
espera por un callback y sostiene miles de conexiones concurrentes con un hilo.

El precio: **si bloqueas el hilo, bloqueas a todo el mundo**. No hay
degradación gradual, hay parálisis. Por eso hay reglas que en Node no son estilo
sino supervivencia:

- nada de bucles pesados en el camino de una petición;
- nada de `JSON.parse` sobre cuerpos ilimitados;
- el hash de contraseñas (caro por diseño) se hace con `argon2`, cuya
  implementación nativa libera el hilo mientras trabaja.

## Bucle de eventos, en el orden que importa

```
   ┌── timers            setTimeout / setInterval
   │
   ├── pending callbacks
   ├── poll              E/S: aquí llega la respuesta de PostgreSQL
   ├── check             setImmediate
   └── close callbacks
        ↑
        └── entre cada fase: microtareas (promesas, queueMicrotask)
```

Lo único que necesitas retener para este backend: **las promesas (`await`) se
resuelven antes de pasar a la siguiente fase**. Un `await` no cede el control
"un rato": lo cede hasta que su microtarea esté lista, y esa cola se vacía
entera antes de atender nuevos temporizadores.

## Archivos reales

- [`apps/api/src/main.ts`](../../apps/api/src/main.ts) — el arranque del
  proceso, incluidos los *shutdown hooks*.
- [`.nvmrc`](../../.nvmrc) — versión para desarrollo local.
- [`apps/api/Dockerfile`](../../apps/api/Dockerfile) — `FROM node:24-bookworm-slim`.
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — `NODE_VERSION: '24'`.

## Código real

Arranque asíncrono. Nada en el fichero se ejecuta "suelto": todo vive dentro de
`bootstrap()` y el error de una promesa no capturada se convertiría en un fallo
de arranque visible, no en un proceso zombi:

```ts
// apps/api/src/main.ts
async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    trustProxy: true,
    genReqId: (request: IncomingMessage) =>
      (request.headers['x-request-id'] as string | undefined) ?? randomUUID(),
  });
  // ...
  app.enableShutdownHooks();
  await app.listen({ port: config.port, host: config.host });
}

void bootstrap();
```

Dos detalles que parecen menores y no lo son:

- **`genReqId`**: cada petición recibe un identificador. Es la única forma de
  correlacionar una línea de log, una fila de auditoría y el `requestId` que
  devolvemos en el cuerpo de un error. Cuando un usuario te diga "me ha dado un
  error", le pedirás ese identificador.
- **`enableShutdownHooks()`**: al recibir `SIGTERM` —lo que hace Docker o
  Kubernetes al parar el contenedor— Nest cierra los módulos ordenadamente.
  Sin esto, cierras conexiones de PostgreSQL a la fuerza y pierdes las
  peticiones en vuelo.

## Comandos

```bash
node -v                      # debe decir v24.x
nvm use                      # lee .nvmrc

# Ver el proceso en marcha y su consumo
npm run dev -w @qa-flow-hub/api

# Comprobar que el proceso responde a SIGTERM ordenadamente
docker compose up -d api && docker compose stop api && docker compose logs api | tail
```

## Errores comunes

- **`ERR_REQUIRE_ESM` / `Cannot use import statement outside a module`.**
  Convivimos con dos sistemas de módulos: la API compila a CommonJS (Nest y sus
  decoradores lo hacen más simple) y el frontend usa ESM. Por eso
  `packages/shared` se compila **dos veces**, a `dist/esm` y a `dist/cjs`, y
  cada carpeta lleva su propio `package.json` con el `type` correcto
  ([`packages/shared/scripts/write-module-markers.mjs`](../../packages/shared/scripts/write-module-markers.mjs)).
- **Usar la versión de Node del sistema.** Si `node -v` no dice 24, cualquier
  error que veas puede ser tuyo o de la versión. Ejecuta `nvm use` primero,
  siempre.
- **Confiar en `process.env` sin validar.** Un `undefined` silencioso en una
  cadena de conexión produce un error tres capas más abajo. Ver capítulo 07.
- **Bloquear el hilo con criptografía síncrona.** `crypto.pbkdf2Sync` en un
  handler HTTP tumba el servidor bajo carga. Usa las variantes asíncronas.

## Preguntas de repaso

1. ¿Por qué un backend de Node soporta miles de conexiones con un solo hilo, y
   en qué escenario concreto eso deja de ser una ventaja?
2. ¿Qué hace `enableShutdownHooks()` y qué se rompe si lo quitas?
3. ¿Para qué sirve `genReqId` y dónde vuelve a aparecer ese identificador?
4. ¿Por qué hay cuatro sitios donde se declara la versión de Node?

## Ejercicios

1. Añade temporalmente en el controlador de salud un bucle
   `while (Date.now() - t < 3000) {}` y lanza dos peticiones simultáneas. Mide
   cuánto tarda la segunda. Explica el resultado. Luego deshaz el cambio.
2. Cambia `.nvmrc` a `20`, ejecuta `npm install` y describe qué avisa `engines`.
   Vuelve a 24.
3. Envía `SIGTERM` al proceso de la API (`kill -TERM <pid>`) y observa los logs
   de cierre.

## Qué diría en una entrevista

> "Node encaja bien en una API de gestión porque el trabajo real es esperar a
> PostgreSQL, no calcular. La regla que aplico es no bloquear nunca el bucle:
> criptografía asíncrona, sin bucles pesados en el camino de la petición, y
> apagado ordenado con `SIGTERM` para no cortar peticiones en vuelo. Fijo la
> versión del runtime en el repositorio, la imagen y CI, porque una divergencia
> ahí produce fallos que solo aparecen en producción."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Procesos | Uno | Varias réplicas tras un balanceador |
| Trabajos en segundo plano | Ninguno | Cola dedicada (importaciones, sincronización con Jira) |
| Observabilidad | Logs con `requestId` | Trazas OpenTelemetry |

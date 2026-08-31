# 31 — Docker

## Concepto

Docker empaqueta la aplicación con su sistema de archivos y sus dependencias, de
forma que se ejecute igual en tu portátil que en CI que en un servidor. Docker
Compose orquesta varios contenedores como un stack.

En este proyecto Compose levanta **cuatro servicios**:

| Servicio | Qué es | Puerto |
| --- | --- | --- |
| `postgres` | Base de datos de desarrollo | 5432 |
| `postgres-test` | Base de datos de pruebas, desechable | 5433 |
| `api` | La API compilada | 3000 |
| `web` | nginx sirviendo el bundle de React | 8080 |

No hay Redis. Es una ausencia deliberada: las sesiones y los tokens de refresco
viven en PostgreSQL y el limitador de peticiones es en memoria. Añadir Redis
sería añadir un servicio que operar, respaldar y monitorizar sin necesidad
todavía.

## Qué problema resuelve

Dos cosas distintas:

1. **Entorno reproducible.** Nadie instala PostgreSQL a mano ni descubre que
   tenía la versión 13.
2. **Artefacto de despliegue.** La imagen de la API es lo que se publica; no se
   copia código fuente a un servidor.

## Archivos reales

- [`docker-compose.yml`](../../docker-compose.yml)
- [`apps/api/Dockerfile`](../../apps/api/Dockerfile)
- [`apps/web/Dockerfile`](../../apps/web/Dockerfile)
- [`apps/web/nginx.conf`](../../apps/web/nginx.conf)
- [`.dockerignore`](../../.dockerignore)

## La imagen de la API, etapa por etapa

```dockerfile
FROM node:24-bookworm-slim AS base
FROM base AS deps      # solo manifiestos + npm ci
FROM deps AS build     # código + compilación
FROM base AS runtime   # solo dependencias de producción + dist
```

Tres ideas que hacen que esto sea una imagen decente y no un `COPY . .`:

**1. Los manifiestos se copian antes que el código.**

```dockerfile
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci
```

Docker cachea por capa. Si solo cambia un `.ts`, la capa de `npm ci` se reutiliza
y la construcción tarda segundos en lugar de minutos. Si copiases todo antes,
cada cambio de código reinstalaría las dependencias.

**2. El compilador no viaja a producción.** La etapa `runtime` reinstala con
`--omit=dev` y copia únicamente el resultado:

```dockerfile
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
```

Esa segunda línea es fácil de olvidar y produce el error
`@prisma/client did not initialize yet`: el cliente de Prisma **se genera** en la
etapa de construcción y hay que llevarse el resultado.

**3. No se ejecuta como root.**

```dockerfile
USER node
```

Si alguien logra ejecutar código dentro del contenedor, no empieza con uid 0.

## El servicio web

El frontend es un bundle estático. La imagen final es nginx, y su configuración
hace de proxy inverso hacia la API:

```nginx
location /api/ { proxy_pass http://api:3000/api/; }
location = /health { proxy_pass http://api:3000/health; }
location / { try_files $uri $uri/ /index.html; }
```

Dos consecuencias:

- El navegador llama a `/api/...` **en su propio origen**, así que no hay
  petición cross-origin y CORS deja de ser relevante en este despliegue. CORS
  sigue configurado porque en desarrollo (Vite en 5173, API en 3000) sí hace
  falta.
- `try_files ... /index.html` es lo que hace funcionar el enrutado del lado del
  cliente: recargar `/projects/42` debe devolver la aplicación, no un 404.

El cacheado también está resuelto: los assets con hash se marcan inmutables por
un año y el `index.html` con `no-cache`, porque si el HTML se cachea los usuarios
siguen cargando el bundle viejo tras un despliegue.

## Compose: los detalles que importan

**Salud, no arranque.** La API espera a que PostgreSQL esté *listo*, no a que el
contenedor exista:

```yaml
depends_on:
  postgres:
    condition: service_healthy
```

**La base de datos de pruebas vive en tmpfs**, sin volumen:

```yaml
tmpfs:
  - /var/lib/postgresql/data
```

Una base de datos de test es desechable por definición; en memoria, truncar
tablas entre suites es notablemente más rápido.

**Los secretos se exigen, no se incrustan:**

```yaml
JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET:?set JWT_ACCESS_SECRET in your .env}
```

La sintaxis `:?mensaje` hace que `docker compose up` falle con ese mensaje si la
variable no está. Nada de valores por defecto para un secreto.

**Healthcheck de la API sin curl**, porque la imagen slim no lo trae:

```yaml
test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
```

## Verificación real

```bash
docker compose up -d --build
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
```

```
SERVICE         STATUS
api             Up 16 seconds (healthy)
postgres        Up 21 seconds (healthy)
postgres-test   Up 21 seconds (healthy)
web             Up 15 seconds
```

```bash
curl -s http://localhost:8080/health     # a través de nginx → {"status":"ok",...}
curl -s http://localhost:3000/health     # directo a la API
```

## Comandos

```bash
docker compose up -d --build          # todo
docker compose up -d postgres postgres-test   # solo bases de datos (desarrollo local)
docker compose logs -f api
docker compose exec postgres psql -U qaflow -d qa_flow_hub
docker compose down                   # parar
docker compose down -v                # parar y BORRAR los datos
```

## Errores comunes

- **`@prisma/client did not initialize yet`** en el contenedor: falta copiar
  `node_modules/.prisma` desde la etapa de construcción.
- **Reconstrucciones lentísimas**: copiaste el código antes que los manifiestos
  y perdiste la caché de `npm ci`.
- **`port is already allocated`**: tienes la API corriendo en local y en Compose
  a la vez. Para una de las dos.
- **`docker compose down -v` por costumbre.** La `-v` borra el volumen de datos.
- **Esperar a que el frontend recargue en caliente dentro del contenedor.** La
  imagen de `web` sirve un bundle **compilado**. Para desarrollar, usa
  `npm run dev` en el host y Compose solo para las bases de datos.

## Preguntas de repaso

1. ¿Por qué se copian los `package.json` antes que el código fuente?
2. ¿Qué se rompe si la etapa de runtime no copia `node_modules/.prisma`?
3. ¿Por qué la base de datos de pruebas no tiene volumen?
4. ¿Por qué CORS es irrelevante en el despliegue con nginx pero necesario en
   desarrollo?

## Ejercicios

1. Mide el tamaño de la imagen de la API (`docker images`). Compárala con una
   versión de una sola etapa que no use `--omit=dev`.
2. Rompe a propósito el healthcheck (cambia el puerto) y observa cómo Compose
   marca el servicio `unhealthy` y `web` sigue arrancando.
3. Añade un servicio `adminer` para inspeccionar la base de datos desde el
   navegador y documenta el puerto.

## Qué diría en una entrevista

> "La imagen de la API es multi-etapa: los manifiestos se copian primero para
> aprovechar la caché de `npm ci`, el compilador se queda en la etapa de build y
> la imagen final solo lleva dependencias de producción, el `dist` y el cliente
> de Prisma generado, ejecutándose como usuario sin privilegios. En Compose, la
> API espera a que PostgreSQL esté *healthy*, no simplemente arrancado, y los
> secretos se declaran obligatorios con `:?` para que nunca haya un valor por
> defecto en el fichero."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Registro de imágenes | Construcción local | Publicar en GHCR con etiquetas por commit |
| Migraciones | `npm run db:migrate` a mano | Job de migración previo al despliegue |
| Orquestación | Compose | Kubernetes o un PaaS, con réplicas |
| TLS | No | Terminación TLS en el proxy |

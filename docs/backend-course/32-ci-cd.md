# 32 — Integración continua

## Concepto

La integración continua ejecuta, en cada push y cada pull request, el mismo
conjunto de comprobaciones que ejecutarías tú: lint, tipos, pruebas y
construcción. Su valor no es "ejecutar tests", es **hacer imposible fusionar
código que no pasa las comprobaciones**.

El pipeline vive en
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) y tiene tres jobs:

| Job | Qué hace | Necesita base de datos |
| --- | --- | --- |
| `static` | lint, typecheck, tests unitarios, build | No |
| `integration` | tests de integración contra PostgreSQL real | Sí (5433) |
| `e2e` | Playwright contra el bundle de producción | Sí (5434) |

## Qué problema resuelve

Separar los jobs no es estética: **el feedback rápido llega rápido**. Un error de
tipos aparece en un minuto en `static` sin esperar a que arranque una base de
datos, un servidor y un navegador. Y los tres corren en paralelo, así que el
tiempo total es el del más lento, no la suma.

## Código real

Cancelar ejecuciones obsoletas cuando haces push tres veces seguidas:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

Sin esto, tres pushes producen tres pipelines completos compitiendo por
runners, y los dos primeros ya no le importan a nadie.

Versión de Node en una sola variable, que debe coincidir con `.nvmrc` y con los
`Dockerfile`:

```yaml
env:
  NODE_VERSION: '24'
```

El orden del job estático no es arbitrario:

```yaml
- run: npm ci
- run: npm run db:generate          # tipos de Prisma: sin ellos no compila nada
- run: npm run build -w @qa-flow-hub/shared   # la API y el web lo importan compilado
- run: npm run lint
- run: npm run typecheck
- run: npm run test
- run: npm run build
```

`db:generate` va antes que todo lo demás porque el cliente de Prisma es **código
generado**: no está en el repositorio, y sin él el typecheck falla con cientos
de errores desconcertantes. Y `shared` se construye antes porque los otros dos
paquetes lo consumen desde `dist`.

`npm ci` (no `npm install`) porque instala exactamente lo que dice
`package-lock.json` y falla si el lock no está sincronizado con los
`package.json`. En CI quieres esa rigidez.

PostgreSQL como servicio, con espera de salud:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports: ['5433:5432']
    options: >-
      --health-cmd "pg_isready -U qaflow -d qa_flow_hub_test"
      --health-interval 5s --health-retries 20
```

El puerto 5433 es el mismo que usa la base de datos de pruebas en local
([`apps/api/test/setup.ts`](../../apps/api/test/setup.ts)), de modo que la
configuración de los tests no cambia entre tu máquina y CI.

En el job de e2e, esperar a que la API esté viva antes de lanzar el navegador:

```yaml
nohup node apps/api/dist/main.js > api.log 2>&1 &
for _ in $(seq 1 60); do
  if curl -sf http://localhost:3000/health > /dev/null; then exit 0; fi
  sleep 1
done
cat api.log >&2
exit 1
```

Dos detalles deliberados: un `sleep 30` fijo sería más lento y menos fiable que
sondear, y `cat api.log` en el fallo es lo que convierte "el e2e falló" en "la
API no arrancó porque faltaba una variable". Un CI que falla sin decir por qué
cuesta más tiempo del que ahorra.

Y las trazas de Playwright se suben solo si algo falló:

```yaml
- uses: actions/upload-artifact@v4
  if: failure()
  with: { name: playwright-report, path: apps/web/playwright-report }
```

## Los secretos en CI

Los valores JWT del workflow son **cadenas de usar y tirar** para una base de
datos efímera:

```yaml
JWT_ACCESS_SECRET: ci-access-secret-value-with-enough-length
```

No son secretos reales y no protegen nada: la base de datos se destruye al
terminar el job. Cuando exista despliegue, las credenciales reales irán en
GitHub Secrets y nunca en el YAML.

## Comandos

Reproducir el pipeline en local, en el mismo orden:

```bash
npm ci
npm run db:generate
npm run build -w @qa-flow-hub/shared
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:integration
npm run test:e2e
```

Si eso pasa en tu máquina, pasa en CI. Cuando no es así, casi siempre es por una
variable de entorno o por `node_modules` sucio (`rm -rf node_modules && npm ci`).

## Errores comunes

- **`npm ci` falla con `lock file does not satisfy`.** Editaste un
  `package.json` sin ejecutar `npm install`. Commitea el `package-lock.json`.
- **Cientos de errores de tipos en CI y ninguno en local.** Falta
  `npm run db:generate`: en local tienes el cliente generado de antes.
- **El job de e2e se cuelga.** La API no arrancó; mira el `api.log` que el
  propio paso vuelca al fallar.
- **Tests que pasan en local y fallan en CI de forma intermitente.** Suelen
  depender de datos de la ejecución anterior. La suite de integración corre en
  un solo hilo (`fileParallelism: false`) y trunca tablas precisamente por eso.

## Preguntas de repaso

1. ¿Por qué `npm ci` y no `npm install`?
2. ¿Por qué `db:generate` va antes del typecheck?
3. ¿Qué hace el bloque `concurrency` y qué problema evita?
4. ¿Por qué los tests de integración no corren en paralelo?

## Ejercicios

1. Añade un job `docker` que ejecute `docker compose build` para detectar
   Dockerfiles rotos antes de desplegar.
2. Añade cobertura al job estático y publícala como artefacto.
3. Configura la rama `main` como protegida exigiendo los tres jobs, y explica
   por qué eso convierte el CI en una garantía y no en una sugerencia.

## Qué diría en una entrevista

> "El pipeline está partido en tres jobs por velocidad de feedback: lo que no
> necesita base de datos corre primero y en paralelo con el resto. Genero el
> cliente de Prisma y compilo el paquete de contratos antes del typecheck,
> porque son código generado que no está versionado. En el job end-to-end espero
> activamente a la sonda de salud en lugar de dormir un tiempo fijo, y vuelco el
> log de la API cuando falla, para que el fallo sea diagnosticable sin
> reproducirlo."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Despliegue | No hay | Job de despliegue con aprobación manual por entorno |
| Imágenes | Se construyen en local | Publicadas en GHCR y etiquetadas por commit |
| Seguridad | `npm audit` manual | `audit` y escaneo de imágenes en el pipeline |
| Migraciones | Manuales | Job previo al despliegue, con rollback documentado |

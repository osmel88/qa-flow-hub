# 33 — Depuración

## Concepto

Depurar no es poner `console.log`. Es **reducir el espacio de búsqueda**: pasar de
"la aplicación va mal" a "esta consulta, con estos parámetros, en este contexto de
tenant, devuelve lo que no debe". Este capítulo es el conjunto de herramientas que
este repositorio ya tiene para hacer esa reducción, y el orden en que conviene
usarlas.

## Qué problema resuelve

En un backend con guards globales, `AsyncLocalStorage`, transacciones y RLS, los
síntomas rara vez apuntan a la causa:

| Síntoma | Causa habitual, y no la evidente |
| --- | --- |
| `404` en un recurso que existe | Estás actuando como otra organización |
| `401` en un endpoint que debía ser público | Falta `@Public()` |
| Una consulta devuelve 0 filas en producción y todas en un test | Los tests conectan como propietario; la API, como `qaflow_app` |
| `Nest can't resolve dependencies of X` | Un `import type` en un constructor inyectado |
| Un test pasa solo y falla en la suite | Estado compartido: contadores por organización, `truncate` que no corrió |
| Una escritura "se pierde" | La transacción hizo *rollback* por un error posterior |

## La herramienta más barata: el `requestId`

```ts
// apps/api/src/main.ts
genReqId: (request) => (request.headers['x-request-id'] as string | undefined) ?? randomUUID(),
```

Ese id va en la respuesta de error, en cada línea de log y en la fila de
auditoría. Con él, un ticket que dice "no me deja guardar, id `9f2c...`" se
convierte en un `grep`, y no en una reconstrucción a partir de la hora aproximada.

Y como se **acepta** desde la cabecera, puedes enviarlo tú:

```bash
curl -s -H 'x-request-id: bug-1234' localhost:3000/api/v1/projects | jq
grep bug-1234 /tmp/api.log
```

Es la diferencia entre buscar tu petición entre las de todos y buscar una cadena
que tú elegiste.

## Ver el SQL que Prisma ejecuta de verdad

`PrismaService` emite eventos de log. Para depurar una consulta, súbelo a `query`
temporalmente:

```ts
super({ log: [{ emit: 'event', level: 'query' }] });
// y en onModuleInit
this.$on('query', (event) => console.log(event.query, event.params));
```

Lo que hay que mirar en esa salida no es la sintaxis: es **si aparece
`"organizationId" = $1`**. Una consulta sin ese predicado es un `where` que se
escapó del repositorio tenant-aware, y desde la deuda #4 su síntoma es "no
devuelve nada" en runtime, porque RLS la filtra. Ese cambio de síntoma es
deliberado: antes fallaba devolviendo demasiado.

Alternativa sin tocar código, y a menudo mejor:

```sql
-- en psql, como propietario
ALTER SYSTEM SET log_statement = 'all';
SELECT pg_reload_conf();
```

## Reproducir el contexto de tenant a mano

La mayoría de los "no encuentro el bug" en este backend son de contexto. Se
reproduce en tres pasos:

```bash
# 1. ¿Qué organización estoy usando?
curl -s -H "authorization: Bearer $TOKEN" localhost:3000/api/v1/organizations | jq '.[].id'

# 2. La misma petición con la organización explícita
curl -s -H "authorization: Bearer $TOKEN" -H "x-organization-id: $ORG" \
  localhost:3000/api/v1/projects | jq

# 3. La verdad, sin la aplicación en medio
psql "$DATABASE_MIGRATION_URL" -c \
  'SELECT id, "organizationId", name FROM projects WHERE id = '"'$ID'"';'
```

El paso 3 es el que zanja la discusión: si la fila existe con otro
`organizationId`, no hay bug, hay un `404` correcto.

## RLS cambia cómo se depura

Con la API conectada como `qaflow_app`, una consulta fuera de contexto devuelve
**cero filas sin error**. Para comprobar si el problema es la política:

```sql
-- Sin anunciar organización: 0 filas es la respuesta correcta
SELECT count(*) FROM projects;

-- Anunciándola, dentro de una transacción
BEGIN;
SELECT set_config('app.current_organization', '<org-id>', TRUE);
SELECT count(*) FROM projects;
COMMIT;
```

Si el segundo bloque devuelve filas y la API no, el problema está en el contexto
que la API anuncia, no en la política. Si ninguno devuelve nada, el dato no está
donde crees. Dos preguntas distintas, dos comandos distintos.

## Depurar un test, no la aplicación

```bash
# Un solo fichero, un solo caso, con el nombre exacto
cd apps/api
npx vitest run -c vitest.integration.config.ts test/defects.int-spec.ts -t 'derives'
```

Para inspeccionar el estado que dejó un fallo, comenta la llamada a
`truncateAllTables()` del `afterEach` del fichero y consulta la base de datos de
test con `psql "$TEST_DATABASE_URL"`. Recuerda deshacerlo: si no, el siguiente
test hereda las filas y el fallo se mueve de sitio.

La suite de integración corre en **un solo hilo** a propósito: comparte una base
de datos y los contadores por organización (`WEB-R-1`, `WEB-D-1`) son estado
global. Si un test pasa solo y falla acompañado, la sospecha correcta es orden y
estado compartido, no una condición de carrera del código de producción.

## El depurador de verdad

`console.log` responde "qué valor tenía"; el depurador responde "cómo llegué
aquí", que es la pregunta difícil en un pipeline con tres guards globales, un
middleware de contexto y un pipe de validación por parámetro.

```bash
npx nest start --debug --watch -p apps/api/tsconfig.json
```

Con `chrome://inspect` o el depurador del editor, el punto de interrupción que más
enseña de este backend está en `ActiveOrganizationGuard`: ver la pila desde la
petición hasta `AsyncLocalStorage` explica de una vez por qué ningún repositorio
recibe `organizationId` como argumento.

## Errores comunes al depurar aquí

- **Cambiar el test para que pase.** Si un test de aislamiento falla, la hipótesis
  por defecto es que el código tiene el bug. Cambiar la aserción es convertir un
  fallo de seguridad en una regresión silenciosa.
- **Depurar con el rol propietario y concluir que "funciona".** El propietario está
  exento de RLS: reproduce con `qaflow_app` o no has reproducido nada.
- **Poner `console.log` en un repositorio y no ver nada.** Si la línea está después
  de un `await` de una transacción que falló, no se ejecuta. Mira el `catch`.
- **Confiar en el `id` de un log de auditoría para buscar en otra organización.**
  El endpoint de auditoría también es tenant-aware: no verás la fila de otra.
- **Reiniciar la API y ver un fallo distinto.** Prisma cachea el cliente
  generado; tras cambiar el esquema hace falta `npm run db:generate`.

## Preguntas de repaso

1. ¿Qué tres sitios comparten el `requestId` y por qué eso hace barato depurar?
2. ¿Cómo distingues un `404` legítimo entre organizaciones de un bug?
3. Con RLS activa, ¿qué síntoma tiene una consulta sin filtro de tenant?
4. ¿Por qué la suite de integración corre en un solo hilo?
5. ¿Por qué depurar como propietario puede darte una conclusión falsa?

## Ejercicios

1. Provoca un `404` pidiendo un proyecto de otra organización y demuestra con
   `psql` que la fila existe. Escribe en una línea por qué la API tiene razón.
2. Activa el log de `query` de Prisma y cuenta cuántas consultas ejecuta
   `GET /dashboard`. Compáralo con lo que dice el capítulo 34.
3. Rompe a propósito un `import` de constructor cambiándolo a `import type` y
   aprende a reconocer el mensaje `Nest can't resolve dependencies of`.
4. Ejecuta un test de integración aislado con `-t` y luego la suite entera;
   comprueba que el contador de claves (`WEB-R-n`) cambia según el orden.
5. Pon un punto de interrupción en `ActiveOrganizationGuard` y anota la pila de
   llamadas hasta el repositorio.

## Qué diría en una entrevista

> "Lo que más tiempo me ahorra no es una herramienta, es que cada petición tenga
> un id que aparece en la respuesta, en los logs y en la auditoría: convierte un
> informe vago en un `grep`. Después, el orden importa: primero reproduzco con el
> contexto explícito —token y organización— y luego consulto la base de datos sin
> la aplicación en medio, porque la mitad de los '404 raros' de un producto
> multi-tenant son 404 correctos.
>
> Un detalle que aprendí al activar RLS: cambió el síntoma de una consulta mal
> filtrada. Antes devolvía demasiado; ahora devuelve cero. Eso obliga a depurar
> con el rol de la aplicación y no con el propietario, porque el propietario está
> exento de las políticas y te haría concluir que todo funciona."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Correlación | `requestId` propio propagado a logs y auditoría | Trazas distribuidas (OpenTelemetry) con *spans* de Prisma |
| Logs | Pino a stdout | Agregador con retención y búsqueda estructurada |
| Errores | Filtro único, traza en logs del servidor | Sentry con agrupación y contexto de organización |
| SQL lento | A mano, activando el log de consultas | `pg_stat_statements` y alertas sobre p95 |

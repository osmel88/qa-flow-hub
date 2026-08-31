# 34 — Rendimiento

## Concepto

En un backend como este el rendimiento **no** es Node.js. Es cuántas veces vas a
la base de datos, cuántas filas traes y qué índice usa el `where`. El proceso pasa
la mayor parte del tiempo esperando a PostgreSQL, así que optimizar el JavaScript
antes de contar consultas es optimizar el 5 % del problema.

## Qué problema resuelve

Los tres patrones que hunden un SaaS de gestión, en orden de frecuencia:

1. **N+1**: una consulta para la lista y una más por cada elemento. Con 50
   requisitos son 51 idas y vueltas; el código parece limpio y la latencia crece
   de forma lineal con los datos del cliente.
2. **Traer filas para contarlas.** `findMany().length` mueve megabytes por la red
   para producir un entero.
3. **Un `where` sin índice.** Funciona perfectamente con los datos de tu portátil
   y hace un *sequential scan* sobre la tabla del cliente grande.

## Archivos reales

```
apps/api/src/modules/dashboard/dashboard.repository.ts   agregados: solo count y groupBy
apps/api/src/modules/traceability/traceability.service.ts  matriz: 4 consultas y 2 mapas
apps/api/prisma/schema.prisma                            39 índices, todos con organizationId
packages/shared/src/common/pagination.ts                 el límite de página es un contrato
```

## Regla 1: contar es `count`, agrupar es `groupBy`

```ts
countProjects(archived: boolean): Promise<number> {
  return this.prisma.project.count({ where: this.active({ status: ... }) });
}

async requirementsByStatus(projectId?: string): Promise<GroupedCount[]> {
  const rows = await this.prisma.requirement.groupBy({
    by: ['status'],
    where: this.active(projectId === undefined ? {} : { projectId }),
    _count: { _all: true },
  });
  return rows.map((row) => ({ key: row.status, count: row._count._all }));
}
```

Todo el repositorio del dashboard es así: **ningún método carga filas que solo va
a contar**. El comentario de la clase lo dice, y es una regla verificable al
revisar código, no una intención.

## Regla 2: el número de consultas no depende del número de datos

`GET /dashboard` ejecuta **ocho agregados en paralelo** con `Promise.all`, más una
consulta de progreso para los runs recientes. Nueve consultas, sea la organización
de tres proyectos o de trescientos:

```ts
const [activeProjects, archivedProjects, requirements, testCases, runs,
       recentRuns, results, defects, requirementCount, coveredCount] =
  await Promise.all([...]);
```

Dos cosas que parecen detalles:

- **`Promise.all` y no `await` en serie**: la latencia es la del agregado más
  lento, no la suma. Con nueve consultas de 8 ms, la diferencia es 8 ms frente a
  72 ms, y el usuario percibe la segunda.
- La versión ingenua de la cobertura sería «por cada requisito, ¿tiene enlaces?».
  Aquí es una consulta de ids y un `groupBy` sobre los enlaces:

```ts
const links = await this.prisma.traceabilityLink.groupBy({
  by: ['sourceId'],
  where: this.scope({ sourceType: 'requirement', targetType: 'test_case',
                      sourceId: { in: requirements.map((r) => r.id) } }),
});
```

La matriz de trazabilidad sigue el mismo patrón: **cuatro consultas y dos mapas en
memoria**, nunca una consulta por requisito. Es el caso donde la ingenuidad se
paga más caro, porque la matriz es justamente el informe que se vende.

Límite honesto del `in`: PostgreSQL admite una lista larga, pero con decenas de
miles de requisitos habría que paginar el propio informe. Está anotado como deuda
con su disparador, no presentado como infinito.

## Regla 3: el índice empieza por `organizationId`

39 índices en el esquema, y casi todos son compuestos empezando por el tenant:

```prisma
@@index([organizationId, projectId, status])
@@index([organizationId, projectId, deletedAt])
@@index([organizationId, suiteId, sectionId])
```

No es casual: **toda** consulta lleva `organizationId` porque lo inyecta el
repositorio, así que un índice que no empiece por esa columna no sirve para las
consultas que realmente existen. El orden de las columnas de un índice compuesto
es su parte más importante: `(organizationId, status)` sirve para filtrar por
organización y por organización+estado; `(status, organizationId)` no sirve para lo
primero.

Los `@@index([deletedAt])` acompañan al borrado lógico: `active()` añade
`deletedAt: null` a cada consulta, de modo que esa columna aparece en casi todos
los planes.

## Regla 4: la paginación es un contrato, no una cortesía

```ts
// packages/shared/src/common/pagination.ts
pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
```

`MAX_PAGE_SIZE` es 100 y vive en el esquema Zod compartido, así que **el cliente no
puede pedir 10 000 filas**: la validación rechaza la petición antes de llegar al
servicio. Un endpoint de lista sin tope superior es una
denegación de servicio que se activa sola el día que un cliente crece: no hace
falta un atacante.

## Cómo medir antes de optimizar

```bash
# 1. ¿Cuántas consultas hace este endpoint?
#    Activa el log de query de Prisma (capítulo 33) y cuéntalas.

# 2. ¿Qué plan usa esta consulta?
psql "$DATABASE_MIGRATION_URL" -c '
  EXPLAIN ANALYZE
  SELECT * FROM test_cases
  WHERE "organizationId" = $$org$$ AND "projectId" = $$proj$$ AND "deletedAt" IS NULL;'

# 3. ¿Cuánto tarda de verdad, incluido el pipeline completo?
curl -s -o /dev/null -w '%{time_total}\n' -H "authorization: Bearer $TOKEN" \
  -H "x-organization-id: $ORG" localhost:3000/api/v1/dashboard
```

Lo que hay que buscar en el `EXPLAIN ANALYZE` es `Index Scan` frente a `Seq Scan`
— y con pocas filas verás `Seq Scan` aunque el índice exista, porque para una
tabla pequeña es más rápido. Ahí está el error de medición más común: **un plan
sobre datos de juguete no dice nada**. Genera volumen antes de concluir.

## Lo que este backend deliberadamente no optimiza

Tres decisiones tomadas a favor de la simplicidad, todas anotadas:

- **El dashboard agrega en cada petición.** Sin caché ni vistas materializadas.
  Con nueve agregados indexados es perfectamente razonable hasta un volumen que
  aún no tenemos; el disparador para cambiarlo es p95 por encima de unos cientos
  de milisegundos.
- **No hay caché.** Añadir Redis introduce invalidación, y la invalidación mal
  hecha en un producto multi-tenant es peor que una consulta lenta: es mostrar
  datos de otro.
- **El límite de peticiones es por instancia.** Es un problema de corrección, no
  de rendimiento, pero se arregla con la misma pieza (un almacén compartido).

Y una que sí es una decisión de rendimiento estructural: **RLS fija
`app.current_organization` dentro de una transacción por consulta**, lo que añade
una sentencia por operación. Es el precio de que el *pooling* siga siendo seguro;
la alternativa —fijarla por conexión— es más rápida y filtra datos entre
peticiones.

## Errores comunes

- **Optimizar el proceso Node antes de contar consultas.** El perfil casi siempre
  dice "esperando a la base de datos".
- **Añadir un índice sin `EXPLAIN`.** Cada índice ralentiza las escrituras y ocupa
  espacio; un índice que el planificador no usa es coste puro.
- **Crear un índice que no empieza por `organizationId`.** Aquí no lo usará
  ninguna consulta real.
- **`findMany` + `.length`** para contar. También: `findMany` sin `select`, que
  trae todas las columnas para leer una.
- **Paralelizar escrituras con `Promise.all` dentro de una transacción.** El orden
  deja de estar garantizado y aparecen *deadlocks*; el paralelismo es para
  lecturas independientes.

## Preguntas de repaso

1. ¿Por qué el número de consultas de `GET /dashboard` no depende del número de
   proyectos?
2. ¿Qué diferencia práctica hay entre `Promise.all` y `await` en serie para nueve
   agregados?
3. ¿Por qué todos los índices compuestos empiezan por `organizationId`?
4. ¿Por qué un `EXPLAIN` con datos de desarrollo puede engañarte?
5. ¿Qué coste de rendimiento introduce RLS y por qué se acepta?
6. ¿Por qué no hay caché en este producto?

## Ejercicios

1. Cuenta las consultas de `GET /dashboard` con el log de Prisma. Confirma que
   son nueve y que no cambian al crear diez proyectos más.
2. Escribe a propósito una versión N+1 de la cobertura (un `count` por requisito),
   mide con 200 requisitos y compárala con la actual. Deshaz.
3. Borra un índice compuesto en una migración local y compara el `EXPLAIN ANALYZE`
   antes y después con al menos 100 000 filas generadas por script.
4. Quita el tope de la paginación en el esquema compartido y pide 100 000 filas.
   Observa el tiempo de respuesta y el uso de memoria. Deshaz.
5. Propón (sin implementar) cómo cachearías el dashboard sin arriesgar fugas
   entre organizaciones: qué clave, qué invalidación y qué pasa en un despliegue.

## Qué diría en una entrevista

> "El rendimiento aquí es un problema de acceso a datos, así que las reglas son
> tres: el número de consultas de un endpoint no puede depender del número de
> datos, nunca se cargan filas para contarlas, y todo índice compuesto empieza por
> `organizationId` porque toda consulta lleva ese filtro; un índice que no empieza
> por ahí no lo usará nadie.
>
> El dashboard es el ejemplo: nueve agregados en paralelo, `count` y `groupBy`, y
> la cobertura resuelta con un `groupBy` sobre los enlaces en vez de una consulta
> por requisito. Y sé lo que no está optimizado: agrega en cada petición, sin
> caché. Es deliberado, porque una invalidación mal hecha en multi-tenant no es
> lentitud, es enseñar datos de otro cliente. El disparador para cambiarlo está
> escrito: p95 del endpoint."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Dashboard | 9 agregados por petición | Vistas materializadas o caché con invalidación por evento |
| Matriz | 4 consultas y 2 mapas | Paginación del informe y exportación asíncrona |
| Índices | 39, guiados por las consultas existentes | Revisión con `pg_stat_statements` y datos reales |
| Medición | `EXPLAIN ANALYZE` a mano | p95 por endpoint en métricas, alertas por regresión |
| Caché | Ninguna | Redis con clave por organización, invalidación explícita |
| Conexiones | Pool de Prisma por instancia | PgBouncer en modo transacción (compatible con el RLS actual) |

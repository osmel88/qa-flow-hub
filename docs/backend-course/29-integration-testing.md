# 29 — Pruebas de integración

## Concepto

Una prueba de integración aquí arranca **la aplicación real** —los tres guards
globales, el filtro de excepciones, el prefijo, el versionado— contra **PostgreSQL
real**, y la conduce **por HTTP**. Nada está mockeado: ni Prisma, ni la
autenticación, ni el contexto de tenant.

Son 188 pruebas y son la columna vertebral de la calidad de este backend.

## Qué problema resuelve

El riesgo número uno de un SaaS multi-tenant no es un cálculo mal hecho: es que
la organización A lea una fila de la B. Ese fallo **no existe** en ninguna función
pura. Vive en la combinación de un `where` incompleto, un guard que no se aplicó
a esa ruta y una migración sin índice único.

Por eso la pregunta que responden estas pruebas no es «¿funciona el servicio?»
sino:

> Actuando como la organización A, y conociendo el `id` exacto de un recurso de
> la B, ¿puedo leerlo, modificarlo o borrarlo?

Y hay una respuesta comprobada, repetida en cada módulo: `404`.

## Archivos reales

```
apps/api/test/global-setup.ts        aplica migraciones una vez
apps/api/test/setup.ts               entorno de test, secretos desechables
apps/api/test/utils/create-test-app.ts  arranca el Nest real
apps/api/test/utils/workspace.ts        organización + proyecto + miembros por rol
apps/api/vitest.integration.config.ts   un solo hilo, timeouts largos

apps/api/test/health.int-spec.ts         2
apps/api/test/tenancy.int-spec.ts       13
apps/api/test/auth.int-spec.ts          21
apps/api/test/organizations.int-spec.ts 41
apps/api/test/requirements.int-spec.ts  24
apps/api/test/test-design.int-spec.ts   33
apps/api/test/test-runs.int-spec.ts     26
apps/api/test/defects.int-spec.ts       21
apps/api/test/dashboard.int-spec.ts      7
```

## La app de test es la app, no una parecida

```ts
app.setGlobalPrefix('api', { exclude: ['health'] });
app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
app.useGlobalFilters(new AllExceptionsFilter());
```

`create-test-app.ts` replica `src/main.ts` deliberadamente. La tentación es
montar solo el módulo bajo prueba: más rápido, y ciego a la clase de error que
más duele. En F0 pasó exactamente eso: `/health` respondía en las pruebas y
devolvía `404` en producción porque el versionado por URI prefija también las
rutas excluidas del prefijo global. Una prueba con la configuración completa lo
habría dicho el primer día — y desde que se replica, lo dice.

Lo que sí se omite es el logger (`logger: false`) y Swagger: no forman parte del
contrato que se está comprobando.

## Sin servidor HTTP: `app.inject()`

```ts
export function injector(getApp: () => NestFastifyApplication): Injector {
  return (method, url, options = {}) =>
    getApp().inject({
      method,
      url,
      headers: {
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.organizationId === undefined
          ? {}
          : { 'x-organization-id': options.organizationId }),
      },
    });
}
```

`inject` de Fastify recorre **todo** el pipeline —plugins, parseo, guards,
serialización— sin abrir un puerto. Se gana velocidad y se elimina una clase
entera de flakiness: no hay puertos ocupados, ni esperas a que el socket escuche,
ni tests que se pisan entre sí en CI.

Los dos parámetros del helper —`token` y `organizationId`— no son casualidad: son
exactamente las dos dimensiones de la seguridad del producto (*quién eres* y *en
nombre de qué organización actúas*), así que toda prueba puede variar una y fijar
la otra.

## El helper que hace posible probar la seguridad

```ts
addMember(role, emailPrefix = role): Promise<TestAccount>
```

`createWorkspace` monta un dueño, una organización y un proyecto; `addMember`
registra un usuario, lo invita con un rol y **acepta la invitación por él**, todo
por HTTP.

Es el detalle que decide si las pruebas de permisos se escriben o no. Si conseguir
un `tester` autenticado costara veinte líneas de `INSERT`, nadie probaría el
rechazo de un `viewer`. Cuesta una línea:

```ts
const tester = await workspace.addMember('tester');
```

Y como la ruta de creación es la real, el propio helper valida de paso el flujo de
invitaciones en cada archivo que lo usa.

## Aislamiento entre pruebas: truncar, no transacciones

```ts
await prisma.truncateAllTables();
```

```ts
const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
await this.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
```

Dos decisiones dentro de esta:

**Truncar en vez de envolver cada prueba en una transacción con rollback.** El
truco de la transacción es más rápido, pero prohíbe probar el código que **usa**
transacciones —y aquí las claves legibles, las invitaciones y los resultados de
ejecución dependen de ellas—. Habría que renunciar a probar justo lo delicado.

**`RESTART IDENTITY`** deja los contadores como recién instalado, porque hay
pruebas que afirman `WEB-C-1`; sin ello el número dependería del orden de
ejecución.

Y una salvaguarda que no es decorativa:

```ts
if (process.env['NODE_ENV'] !== 'test') {
  throw new Error('truncateAllTables() is only available when NODE_ENV=test');
}
```

Un método que borra todas las tablas y vive en el código de producción se protege
en el propio método, no confiando en que nadie lo llame.

## Base de datos aparte, en memoria

```yaml
postgres-test:
  ports: ['5433:5432']
  tmpfs:
    - /var/lib/postgresql/data
```

Puerto 5433 para que ejecutar las pruebas **no pueda** vaciar la base de datos de
desarrollo, y `tmpfs` sin volumen porque una base de datos de test es desechable
por definición: truncar 21 tablas entre archivos es notablemente más rápido en
memoria.

Las migraciones se aplican una vez, en `global-setup.ts`, con `migrate deploy` y
no `migrate dev`: se aplica lo commiteado y nada más. Si falta una migración, el
fallo aparece ahí con un mensaje claro en vez de más tarde como «column does not
exist».

## Un solo hilo, a propósito

```ts
fileParallelism: false,
poolOptions: { threads: { singleThread: true } },
```

Todos los archivos comparten una base de datos y truncan entre ellos. En
paralelo, un `TRUNCATE` de un archivo borraría los datos de otro a mitad de
prueba. La alternativa —un esquema PostgreSQL por worker— es el camino cuando la
suite crezca; hoy tarda menos de un minuto y la complejidad no se paga.

## Qué prueban de verdad estos 188 casos

No cobertura de líneas. Estos hechos:

- **Aislamiento**: en cada módulo, la organización A con el `id` de la B recibe
  `404` al leer, actualizar, borrar, duplicar y en la matriz y el dashboard.
- **Autorización real**: un `viewer` no crea; un `tester` no borra; el endpoint de
  auditoría solo lo abren `organization_owner` y `organization_admin`.
- **Autenticación**: login inexistente y contraseña incorrecta responden igual
  —código, mensaje **y tiempo**—; cinco fallos dan `429`; revocar una sesión
  invalida su access token en la petición siguiente; cambiar la contraseña cierra
  las demás sesiones.
- **Consistencia transaccional**: una creación que falla **no consume** el
  contador de `WEB-D-n`; los contadores de requisitos y casos son independientes.
- **Reglas de dominio que dan valor**: la matriz deja de dar por verificado un
  requisito mientras haya un defecto abierto apuntándole; un resultado `passed` no
  puede originar un defecto; el snapshot de un caso no cambia al editar el caso.
- **No filtración**: tras cambiar la contraseña, el log de auditoría no contiene
  ni la contraseña ni el hash Argon2.
- **Mass assignment**: enviar `isActive` o `failedLoginAttempts` en un `PATCH` no
  los aplica.

## Comandos

```bash
docker compose up -d postgres-test
npm run test:integration                                    # los 188
cd apps/api && npx vitest run --config vitest.integration.config.ts test/defects.int-spec.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts -t 'cross-organization'
```

## Errores comunes

**Montar solo el módulo bajo prueba.** Verde en test, `404` en producción: es
literalmente lo que pasó con `/health`.

**Compartir estado entre pruebas.** Una prueba que depende de la anterior falla
sola cuando alguien usa `-t`.

**Sembrar con `INSERT` directos.** Se salta las reglas del servicio y las pruebas
acaban validando un estado que la aplicación nunca produciría.

**Probar «funciona» y no «no se puede».** Sin la prueba del `id` ajeno, el
aislamiento es una intención, no un hecho.

**Reutilizar la base de datos de desarrollo.** El primer `TRUNCATE` borra tu
trabajo. De ahí el 5433.

**Paralelizar sobre una sola base de datos.** Flakiness que se culpa a la red.

**Depender de `Date.now()` o de un orden de ids.** Rompe una vez cada cincuenta
ejecuciones y erosiona la confianza en la suite.

## Preguntas de repaso

1. ¿Por qué la app de test replica el prefijo, el versionado y el filtro?
2. ¿Qué ventajas tiene `app.inject()` frente a levantar el servidor?
3. ¿Por qué truncar y no envolver cada prueba en una transacción?
4. ¿Qué aporta `RESTART IDENTITY`?
5. ¿Por qué la base de datos de test vive en el puerto 5433 y en `tmpfs`?
6. ¿Por qué la suite corre en un solo hilo y qué habría que hacer para
   paralelizarla?
7. ¿Cuál es la prueba que justifica por sí sola toda la suite?

## Ejercicios

1. Borra `organizationId` del `where` de un método de repositorio y comprueba qué
   pruebas se ponen rojas. Cuenta cuántas.
2. Añade una prueba de aislamiento para un endpoint que hoy no la tenga.
3. Paraleliza la suite dando un esquema PostgreSQL por worker y mide la mejora
   frente a la complejidad añadida.
4. Escribe una prueba que confirme que la respuesta de error nunca incluye el
   `stack` con `NODE_ENV=production`.
5. Añade `addProjectMember` al workspace y las pruebas que hoy no pueden
   escribirse porque los guards ignoran `ProjectMember`.
6. Mide el tiempo de la suite y decide si `tmpfs` merece seguir, con números.

## Qué diría en una entrevista

> Mis pruebas de integración arrancan la aplicación completa contra PostgreSQL
> real y la conducen por HTTP con `app.inject()`, sin abrir un puerto. Lo que
> prueban no es que los endpoints funcionen, sino que **no se puede** hacer lo
> prohibido: actúo como la organización A con el `id` exacto de un recurso de la
> B y verifico que recibo 404 en lectura, escritura y borrado, en cada módulo.
> Aíslo truncando tablas y no con transacciones con rollback, porque el rollback
> impediría probar el código que usa transacciones —que es justo el delicado: las
> claves legibles y las invitaciones—. Y la base de datos de test está en otro
> puerto y en tmpfs, para que ejecutar las pruebas no pueda tocar la de
> desarrollo.

## MVP frente a futuro

| Decisión | Ahora | Después |
| --- | --- | --- |
| Transporte | `app.inject()` | Igual |
| Aislamiento | `TRUNCATE` entre archivos | Esquema por worker si la suite crece |
| Paralelismo | Un hilo | Por esquema |
| Base de datos | `postgres-test` en tmpfs | Testcontainers para no depender de compose |
| Datos | Helpers por HTTP | Igual, más factorías por módulo |
| Cobertura de permisos | Riesgos críticos | Matriz completa rol × endpoint generada |
| Contratos | OpenAPI generado | Pruebas de contrato contra el esquema |

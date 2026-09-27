# 27 — Adaptadores de integración

## Concepto

Un adaptador es la pieza que traduce entre el dominio de qa-flow-hub y el
lenguaje de un sistema externo: Jira, TestRail, GitHub Actions, un reporter de
Playwright. El dominio define **el puerto** (la interfaz); cada proveedor
implementa **el adaptador**.

En este MVP no hay ninguna llamada real a la red: solo contratos y proveedores
noop.

## Qué problema resuelve

Sin esta separación, `DefectsService` acabaría con un `if (provider === 'jira')`
y con campos de Jira en el modelo. Cuando llegue el segundo cliente pidiendo
Linear, no habrá sitio donde ponerlo.

## Archivos reales

```
apps/api/src/integrations/adapter.contracts.ts    los puertos
apps/api/src/integrations/adapter.tokens.ts       símbolos de inyección
apps/api/src/integrations/noop.providers.ts       implementaciones vacías
apps/api/src/integrations/integrations.module.ts  el cableado
apps/api/src/integrations/noop.providers.test.ts  4 tests unitarios
```

Y en el esquema, desde F1: `IntegrationConnection` y `ExternalReference`.

## Por qué escribir la interfaz antes que el adaptador

Es lo contrario de lo intuitivo, y es la decisión central del capítulo.

Un puerto diseñado **después** del primer adaptador siempre acaba con la forma
de ese adaptador: métodos que devuelven estructuras de Jira, parámetros que solo
Jira necesita. El segundo proveedor entonces no se añade, se reescribe.

Diseñando el puerto contra el dominio primero, la pregunta que se responde es
«¿qué necesita qa-flow-hub de un issue tracker?», no «¿qué ofrece Jira?».

```ts
export interface IssueTrackerAdapter {
  readonly provider: IntegrationProviderName;
  check(context: AdapterContext): Promise<HealthCheck>;
  createIssue(context: AdapterContext, payload: IssuePayload): Promise<ExternalRef>;
  fetchIssueState(context: AdapterContext, externalId: string): Promise<IssueState | null>;
}
```

Ningún tipo de issue de Jira, ningún id de suite de TestRail, ningún número de
run de GitHub cruza este archivo. Hacia fuera solo sale un `ExternalRef`.

## Los noop fallan, no fingen

```ts
createIssue(_context, payload) {
  return Promise.reject(new IntegrationNotConfiguredError('issue tracker', 'create an issue'));
}
```

Es deliberado. Un stub que responde «creado JIRA-123» le enseña al código que la
integración funciona: el error aparece en producción, donde el id no existe. Un
stub que dice «no configurado» hace visible la pieza que falta en la primera
llamada, en desarrollo.

Las lecturas sí devuelven vacío (`null`, `[]`), porque «no hay nada» es una
respuesta legítima que el llamante ya tiene que manejar.

## Secretos: una referencia, nunca el valor

```ts
export interface AdapterContext {
  organizationId: string;
  connectionId: string;
  secretRef: string | null;
  settings: Record<string, unknown>;
}
```

`IntegrationConnection.secretRef` guarda un puntero a un gestor de secretos, no
un token. Dos consecuencias: un adaptador puede probarse sin credenciales
reales, y un volcado de la tabla de conexiones no da acceso a Jira. `settings`
guarda solo lo no sensible: claves de proyecto, mapeos de campos.

El `NoopEmailAdapter` registra asunto y destinatario, **nunca el cuerpo**: el
cuerpo de una invitación lleva un token usable y un log es el sitio más fácil
donde filtrarlo.

## `ExternalReference`: un puente genérico

```prisma
@@unique([organizationId, provider, entityType, entityId, externalId])
```

Cualquier entidad puede tener referencias en cualquier proveedor sin añadir
columnas. No hay `jiraIssueKey` en `Defect`. Integrar Jira será añadir un
adaptador y filas, no una migración.

## Inyección por token

```ts
{ provide: ISSUE_TRACKER_ADAPTER, useClass: NoopIssueTrackerAdapter }
```

Se inyecta un símbolo, no una clase. Poner Jira mañana es cambiar esta línea, y
el código que lo consume no se entera. Es lo que hace del noop una decisión
reversible en un renglón y no una deuda.

## Pull antes que webhook

Los resultados de CI se **piden** (`fetchResults`), no se reciben. Un webhook
necesita un endpoint público, verificación de firma y protección contra replay:
tres cosas que hay que hacer bien antes de exponer nada. El pull no necesita
ninguna y ya permite la funcionalidad.

## S2-F1: la pantalla de configuración encima de los puertos

La primera fase de Stage 2 añade el módulo que **administra** las conexiones
sin implementar todavía ningún proveedor. Es un buen ejemplo de módulo NestJS
completo sobre un modelo que ya existía:

```
apps/api/src/modules/integrations/
├─ provider-availability.ts              qué modos admite cada proveedor y qué fase lo entrega
├─ integration-settings.repository.ts    TenantAwareRepository: una fila por (organización, proveedor)
├─ integration-settings.service.ts       upsert, connect, disconnect, testConnection, toView()
├─ integration-settings.controller.ts    GET|PUT /integrations/:provider y los tres POST
└─ integration-settings.module.ts        importa IntegrationsModule para reutilizar los puertos
packages/shared/src/integrations/integration.contracts.ts   Zod compartido con el cliente
```

Tres decisiones que conviene estudiar en el código:

1. **La disponibilidad es una tabla estática, no una fila.** `PROVIDER_AVAILABILITY`
   dice que Jira y TestRail solo aceptan `mock`, que GitHub solo acepta `real` y
   que ninguno está implementado. Cambia con una release, así que vive en el
   código; guardarlo en la base de datos sería configuración disfrazada de datos.
2. **La vista pública no puede filtrar un secreto por construcción.**
   `toView()` construye el objeto campo a campo y `secretRef` no aparece: solo
   `hasCredential`. No hay un `omit` sobre la fila de Prisma que pueda quedarse
   corto cuando alguien añada una columna.
3. **Lo no sensible se valida como no sensible.** `nonSensitiveSettingsSchema`
   rechaza claves que parezcan credenciales (`token`, `password`, `apiKey`…).
   Un owner que intente guardar su token en `settings` recibe un 400 con el
   motivo, en lugar de dejarlo en texto plano en una columna JSON.

`Connect` sin proveedor implementado deja la conexión en `pending` y `Test
connection` responde con la fase que entrega el proveedor. Es la misma
filosofía que los noop: **decir la verdad** antes que fingir un `connected`.

La migración `20260831110000_integration_settings` añade `mode`, `enabled`,
`accountMetadata`, `lastConnectionTestAt` y el estado `pending`, y cambia la
unicidad a `(organizationId, provider)`. Se escribió a mano en lugar de con
`prisma migrate dev`: en una base con migraciones ya aplicadas, `migrate dev`
propone un `reset`, y un reset nunca es la respuesta a un checksum.

## S2-F2: el primer adaptador de verdad es un mock

La segunda fase sustituye el noop del issue tracker por `JiraMockIssueTrackerAdapter`
sin que ningún servicio de negocio se entere: siguen inyectando
`ISSUE_TRACKER_ADAPTER`.

```
apps/api/src/integrations/jira-mock/
├─ jira-mock.store.ts      un Jira en memoria por organización: proyectos, usuarios, issues
└─ jira-mock.adapter.ts    traduce el puerto neutro (IssuePayload) al vocabulario Jira
apps/api/src/modules/integrations/
├─ external-references.repository.ts   TenantAwareRepository sobre ExternalReference
├─ jira-sync.service.ts                Requirement/Defect → issue, y la referencia que lo recuerda
└─ jira-sync.controller.ts             /integrations/jira/{projects,catalog,issues,references,sync/*}
```

Lo que merece estudio:

1. **El puerto creció, no el modelo.** `IssueTrackerAdapter` ganó `updateIssue`,
   `getIssue`, `listProjects`, `listIssues` y `describe`. `Requirement` y
   `Defect` no ganaron ninguna columna: la relación con el issue vive en
   `ExternalReference`, que es genérica y ya existía. Cuando llegue TestRail
   usará la misma tabla.
2. **Todo `async`, incluso lo que no espera nada.** El mock podría responder de
   forma síncrona, pero entonces un fallo sería un `throw` y no una promesa
   rechazada, y el servicio se comportaría distinto con el mock que con un
   cliente HTTP. Un mock sirve para ensayar el error de red, no solo el camino
   feliz: por eso existe `settings.simulateFailure`.
3. **Exactamente una referencia por entidad.** Si el proveedor ha perdido el
   issue, el servicio lo recrea y **mueve** la fila al nuevo `externalId`,
   anotando `previousExternalId` en `metadata`. No se crea una segunda fila:
   una entidad con dos referencias "vigentes" al mismo proveedor es una
   pregunta sin respuesta para quien lea la trazabilidad después.
4. **Un fallo del proveedor pinta la conexión; un bug nuestro no.** Solo
   `IntegrationProviderError` actualiza `status = error` y `lastError`. Un
   `NotFoundError` o un fallo de permisos es problema de la petición, no del
   proveedor, y no debe dejar la integración en rojo en Settings.
5. **Determinismo como requisito, no como casualidad.** Los ids empiezan en
   `10100`, las tres issues de semilla consumen `10100`–`10102`, así que el
   primer issue que crea un test es siempre `10103` / `QA-3`. Los tests lo
   afirman literalmente; si algún día te sorprende ese número, ya sabes por qué.

## S2-F3: el segundo mock demuestra que el puerto era el correcto

TestRail entra por `TEST_MANAGEMENT_ADAPTER` con la misma receta, y ningún
módulo de negocio (`test-design`, `test-runs`) supo que ocurrió.

```
apps/api/src/integrations/testrail-mock/
├─ testrail-mock.store.ts    un TestRail en memoria por organización: suites, secciones, casos, runs, tests, results
└─ testrail-mock.adapter.ts  traduce SuitePayload/CasePayload/RunPayload/ResultPayload al vocabulario TestRail
apps/api/src/modules/integrations/
├─ testrail-sync.service.ts     TestSuite/TestCase/TestRun/TestResult → objeto TestRail + su ExternalReference
└─ testrail-sync.controller.ts  /integrations/testrail/{projects,catalog,suites,cases,runs,references,sync/*}
```

Lo que merece estudio:

1. **El puerto se ensanchó antes de escribir el mock.** El
   `TestManagementAdapter` del MVP solo sabía importar casos y exportar un run;
   no daba para crear una suite ni añadir un resultado. Se rediseñó como CRUD
   neutro (`createSuite`, `updateCase`, `fetchRun`, `addResult`…) y el noop se
   actualizó a la vez. Regla: cuando un mock te obliga a tocar la interfaz, es
   la interfaz la que estaba incompleta, no el mock el que se pasa de listo.
2. **Un grafo, no cuatro sincronizaciones sueltas.** Un caso no existe en
   TestRail sin su suite; un run no existe sin sus casos; un resultado no
   existe sin el test de un run. `TestRailSyncService` resuelve las
   dependencias él mismo (`ensureSuite` → `ensureCase` → `ensureRun`) y
   devuelve en `dependencies` las referencias que creó de paso, para que el
   cliente refresque todas las columnas de una vez. La alternativa —obligar al
   usuario a sincronizar en orden— es trasladar al humano una restricción del
   proveedor.
3. **Append-only en los dos lados.** Un `TestResult` nunca se edita aquí, y un
   result de TestRail tampoco. Así que `syncResult` no tiene rama de
   "actualizar": si la referencia existe y el proveedor aún tiene el result,
   responde `unchanged`; si no, añade uno nuevo y mueve la referencia. Es el
   único sync sin `update*` en el puerto, y no por olvido.
4. **Una enumeración, una migración.** `LinkableEntity` no tenía `test_suite`
   porque el MVP no enlazaba suites con nada. Añadir el valor es un
   `ALTER TYPE … ADD VALUE`, no una tabla: la relación sigue viviendo en
   `ExternalReference`. `TestSuite`, `TestCase`, `TestRun` y `TestResult` no
   ganaron ninguna columna, igual que `Requirement` y `Defect` en F2.
5. **Decidir lo incómodo y anotarlo.** TestRail ata un run a una suite;
   qa-flow-hub no. El servicio elige la suite dominante y deja constancia en
   `metadata.skippedCases` de lo que no cupo. Es una decisión discutible, y
   por eso está escrita en `technical-debt.md` (29) con la alternativa (un
   _plan_ con un run por suite) y el disparador para cambiarla.

## S2-F4: un mock de solo lectura, y la dirección contraria del dato

GitHub entra por `AUTOMATION_PROVIDER_ADAPTER`, y es distinto a los dos
anteriores en algo esencial: **qa-flow-hub no escribe nada en GitHub**. Jira y
TestRail reciben lo nuestro; GitHub nos da lo suyo (workflow runs y resultados
de Playwright) y nosotros lo convertimos en `TestResult`.

```
apps/api/src/integrations/github-mock/
├─ github-mock.store.ts    un GitHub en memoria por organización: repos, ramas, workflows, runs, jobs, artifacts, results
└─ github-mock.adapter.ts  traduce el grafo al vocabulario neutro del puerto (ExternalWorkflowRun, AutomatedResult…)
apps/api/src/modules/integrations/
├─ github-sync.service.ts     TestRun ↔ workflow run; automated result → TestResult + ExternalReference
└─ github-sync.controller.ts  /integrations/github/{repositories,…,results,references,sync/test-runs/:id[/results]}
```

Lo que merece estudio:

1. **El puerto se diseñó para el adaptador real que aún no existe.**
   `AutomationProviderAdapter` tenía un solo método (`fetchResults`); ahora
   tiene la superficie que un `GitHubRealAdapter` necesitará
   (`listRepositories`, `listWorkflowRuns`, `fetchWorkflowRun`, `listJobs`,
   `listArtifacts`, `fetchResults`), con tipos neutros (`ExternalWorkflowRun`,
   `AutomatedResult` con `caseTags`, `framework`, `file`, `project`). Cuando
   llegue el real, cambia el `useClass` del token y nada más: el servicio de
   sync no importa nada de `github-mock/`.
2. **El mock no reserva ids porque no crea nada.** Sus ids son fijos (`1001`…
   `1005`) y sus estados también (`success`, `failure`, `in_progress`,
   `cancelled`). Un mock de solo lectura es más simple que uno CRUD, pero
   obliga a sembrar los casos incómodos —un run en curso sin resultados, un
   artifact caducado, un result sin tag— porque ninguna prueba podrá crearlos.
3. **El enlace es una observación, no una copia.** `linkRun` guarda en la
   `ExternalReference` del run lo que vio (workflow, rama, SHA, status,
   conclusion, actor) y `sameObservation` compara antes de escribir: si nada
   cambió, ni fila ni auditoría. Sin cuerpo en el `POST` significa "refresca lo
   enlazado"; con cuerpo, "enlaza esto otro" (la referencia se mueve con
   `previousExternalId`, como en F2 y F3).
4. **Importar es traducir identidades, y la traducción puede fallar.** Un
   resultado de Playwright dice `@C-1`; el run interno tiene `WEB-C-1`. El
   servicio enumera los casos del run (`listAllRunCases`, sin paginar: los runs
   son finitos por diseño) y resuelve el tag contra ellos. Lo que no casa **no
   se descarta**: vuelve en `skipped` con su razón (`no_case_tag`,
   `case_not_in_run`, `run_not_completed`, `already_imported`). Un import que
   dice "importados 2" y calla los otros 2 es un import en el que no se puede
   confiar.
5. **Una transacción por resultado.** El `TestResult`, la proyección
   `latestStatus` del run-case y su `ExternalReference` se escriben en la misma
   transacción Prisma; para eso `ExternalReferencesRepository.create` acepta un
   `tx` opcional en vez de que el servicio hable con Prisma a mano. Si se cae
   a mitad, no queda un resultado sin referencia que el siguiente import
   volvería a crear.
6. **El caso cerrado no admite importaciones.** Un run `completed`/`aborted`
   rechaza `importResults` igual que rechaza un resultado manual: la
   automatización no tiene un carril privilegiado sobre la regla de negocio.

## S2-F5: una vista que deriva estado en vez de guardarlo

Tras tres proveedores, cada uno con su columna "Jira"/"TestRail"/"GitHub" en
la pantalla que le tocaba, faltaba la pregunta que hace un QA lead: _¿qué de
este proyecto está enlazado fuera, con qué, y sigue siendo verdad?_ S2-F5 la
responde sin proveedor nuevo, sin sync nuevo y sin columna nueva en tablas de
negocio.

```
apps/api/src/modules/integrations/
├─ external-traceability.repository.ts  snapshots tenant-aware de las seis entidades, archivadas y borradas incluidas
├─ external-traceability.service.ts     list(): estado derivado por fila · verify(): sondea los adaptadores
└─ external-traceability.controller.ts  GET /integrations/traceability · POST /integrations/traceability/verify
packages/shared/src/integrations/
└─ external-traceability.contracts.ts   5 estados, 12 issues, la fila neutra (externalKind, previousExternalId…)
```

Lo que merece estudio:

1. **Un `projectId` desnormalizado, y por qué está bien.** `ExternalReference`
   apunta a seis tablas distintas por `entityType`/`entityId`. Listar "las
   referencias del proyecto" era un `UNION` de seis joins, y aun así perdía
   las referencias cuya entidad ya no existe: justo las huérfanas que la
   pantalla debe mostrar. Copiar `projectId` al escribir la referencia (con
   backfill en la migración) resuelve las dos cosas con un índice. Es una
   copia, y una copia se puede desincronizar; hoy nada mueve entidades entre
   proyectos, y la deuda 31 anota qué debe pasar el día que algo lo haga.
2. **El estado no se guarda, se calcula.** `synced`, `linked`, `stale`,
   `missing`, `error` salen de tres lecturas paralelas —referencias, snapshot
   de entidades (`updatedAt`, `archivedAt`, `deletedAt`), conexiones— y una
   función pura por fila. Guardar el estado obligaría a recalcularlo en cada
   edición de cada entidad de seis módulos; derivarlo cuesta una consulta y
   nunca miente sobre lo que la base sabe. Lo que la base **no** sabe (si el
   proveedor borró el objeto) es lo único que requiere `verify`.
3. **Cinco estados y una lista de motivos.** El producto pidió exactamente
   cinco estados. "Huérfana", "duplicada", "archivada" no son estados: son
   razones por las que una fila está en `error` o `stale`. Separar `status`
   (para filtrar y contar) de `issues[]` (para explicar) evita que el enum
   crezca con cada caso nuevo y que la UI tenga que conocer veinte colores.
4. **Los duplicados se cuentan, no se colapsan.** Dos referencias para la misma
   entidad y proveedor, o un mismo id externo en dos entidades, aparecen como
   `error` con su motivo. Los servicios de sync actuales no pueden producirlos
   (una fila por entidad), así que si aparecen vienen de fuera y alguien debe
   decidir; una vista que "elige la más reciente" habría escondido justo el
   dato que importa para auditar.
5. **Las filas `missing` no existen en la base.** Se generan al vuelo para
   las entidades que un proveedor configurado _debería_ rastrear. Si la
   conexión no existe, no hay `missing`: no se puede echar en falta lo que no
   se ha pedido. Los results importados de GitHub nunca son `missing`: solo
   existen una vez importados, y un "falta importar" sería una mentira.
6. **`verify` reutiliza los adaptadores, no los repite.** Sondea con
   `getIssue`, `fetchSuite/Case/Run/Result`, `fetchWorkflowRun` —los mismos
   métodos del sync— y escribe `verifiedAt` y `providerState` en el
   `metadata` de la fila sin tocar `previousExternalId`. El re-sync desde la
   pantalla tampoco es un endpoint nuevo: el web llama al sync del proveedor
   correspondiente, que ya sabe mover la referencia con historial.
7. **Dos trazabilidades, dos pantallas.** `/traceability` sigue siendo la
   matriz interna Requirement ↔ TestCase; `/external-traceability` es esta.
   Mezclarlas habría convertido "cubierto por un caso" y "enlazado a un case
   de TestRail" en la misma afirmación, y no lo son.

## S2-F6: correo sin correo — eventos, libro mayor y un puerto

Las notificaciones son la primera integración que **sale** del producto hacia
una persona, y la primera que puede fallar sin que el negocio deba enterarse.
S2-F6 construye todo el camino y deja al final un proveedor que no envía nada.

```
apps/api/src/
├─ events/domain-events.ts                 5 eventos tipados + DomainEventsPublisher (emitAsync, errores tragados y logueados)
├─ integrations/adapter.contracts.ts       EmailAdapter · EmailMessage · EmailDeliveryOutcome
├─ integrations/email-mock/                MockEmailAdapter: captura en memoria, ids mock-000001, +bounce/+defer
└─ modules/notifications/
   ├─ templates/email-templates.ts         variables tipadas → { subject, text, html }, claves versionadas .v1
   ├─ notifications.repository.ts          ledger tenant-aware, dedupe, transiciones, preferencias
   ├─ notifications.service.ts             listeners: evento → destinatarios → preferencia → plantilla → fila → adapter → estado
   └─ notifications.controller.ts          preferences · provider · list · outbox
```

Lo que merece estudio:

1. **Los módulos de negocio publican hechos, no correos.** `InvitationsService`
   emite `organization.invitation.issued`; no sabe que existe un email. Si
   mañana la invitación también genera un mensaje de Slack, el emisor no
   cambia. El precio es indirección: para saber "quién envía el correo de
   invitación" hay que buscar el listener, no seguir una llamada.
2. **`emitAsync` y un `try/catch` en el publisher.** El listener corre dentro
   de la petición (no hay cola), así que un fallo al renderizar o al enviar
   podría convertir un `PATCH /defects/:id` correcto en un 500. El publisher
   captura, loguea y devuelve: el negocio ya está confirmado, el correo es
   secundario. Es la decisión inversa a la de una transacción, y hay que
   tomarla explícitamente.
3. **El contexto del evento, no el de la petición.** El listener ejecuta con
   `TenantContextService.runForOrganization(event.organizationId)`. Hoy
   coinciden siempre con la petición; el día que un job programado emita
   eventos de varias organizaciones, el filtro tenant y el RLS seguirán
   viendo la organización correcta. El correo de contraseña corre **sin**
   organización, y por eso `notifications.organizationId` es nullable y la
   política RLS tiene dos ramas.
4. **Un libro mayor, no una cola.** Cada intento es una fila con
   `pending → sent | failed | skipped`, motivo, proveedor e id del proveedor.
   La fila se inserta **antes** de llamar al adapter: si el proceso muere en
   medio queda un `pending` que alguien podrá reintentar. Ese "alguien" es el
   worker de la deuda 32; el modelo ya tiene lo que necesita.
5. **`skipped` también se guarda.** Una preferencia desactivada no es "no pasó
   nada": es una decisión auditable ("no te avisé porque lo pediste"). Cuesta
   una fila; ahorra la conversación "¿por qué no me llegó?".
6. **Dedupe por clave, no por memoria.** `dedupeKey` es única en la tabla y se
   construye con el fingerprint del evento (`test_run_assignment:run:user:
hash(casos)`). Un `create` que choca se lee como "ya existe" y no se
   intenta otra vez. Funciona con varias instancias del API sin coordinación;
   una `Set` en memoria no.
7. **La plantilla es una función tipada.** `renderEmail('test_run_assignment', vars)`
   no acepta un `Record<string, unknown>`: si el evento deja de traer
   `projectName`, falla el `tsc`, no el correo en producción. El HTML escapa
   siempre; el texto plano no, porque un nombre con `&` debe leerse como `&`.
8. **Lo que no se guarda.** Ni el cuerpo, ni el `acceptUrl` con token, ni el
   destinatario completo en los logs (solo el dominio). El outbox mock
   redacta las query strings antes de salir por la API. La regla general:
   el ledger responde "qué, a quién, cuándo, resultado"; nunca "qué decía".
9. **Cambiar de proveedor es cambiar un `useClass`.** `EMAIL_ADAPTER` es un
   token de Nest; `MockEmailAdapter` es la única implementación. Un adapter
   SES o SMTP implementa `send(message)`, devuelve `{ accepted, messageId,
reason }` y el servicio no cambia una línea. Lo que **sí** falta —el
   almacén de credenciales, la URL pública, el worker de reintentos— está en
   la deuda 32, en orden.

## S2-F7: bytes que no pasan por la base de datos

La evidencia es la primera integración que mueve **datos grandes** y la
primera cuyo "proveedor" es el disco del servidor. La tentación es escribir
`fs.writeFile` en el servicio; S2-F7 lo evita con el mismo truco de siempre:
un puerto pequeño y dos implementaciones.

```
apps/api/src/
├─ storage/storage-provider.ts            StorageProvider { put, get, head, delete } · isSafeStorageKey · STORAGE_PROVIDER
├─ storage/local-storage.provider.ts      disco bajo STORAGE_LOCAL_ROOT, flags 'wx', path confinado al root
├─ storage/memory-storage.provider.ts     Map<string, Buffer>, failNext() para simular fallos
├─ storage/storage.module.ts              elige la implementación por STORAGE_PROVIDER
└─ modules/attachments/
   ├─ file-inspection.ts                  sanitizar nombre · allow-list · InspectingStream (sha256, bytes, magic, NUL)
   ├─ attachments.repository.ts           resuelve el target (result/defect/run/case) y su projectId, tenant-aware
   ├─ attachments.service.ts              autoriza → key → stream → provider → inspección → metadata → auditoría
   └─ attachments.controller.ts           multipart in, stream out, cabeceras de descarga seguras
```

Lo que merece estudio:

1. **El puerto no sabe qué es un path.** `put(key, Readable)`, `get(key)`,
   `head(key)`, `delete(key)`. Ni URL, ni bucket, ni ACL, ni `fs`. Por eso un
   `S3StorageProvider` cabe sin tocar el servicio; y por eso el servicio no
   puede hacer nada "listo" con el disco aunque quiera.
2. **La key la genera el servidor, siempre.**
   `org/<org>/project/<proj>/<entity>/<uuid>.<ext>`. El nombre del usuario se
   guarda **para mostrar** (sanitizado) y jamás entra en la ruta. Aun así,
   `LocalStorageProvider` vuelve a comprobar que la ruta resuelta sigue bajo
   el root: la defensa en profundidad es barata y el `../` es el error más
   viejo del mundo.
3. **Inspeccionar mientras se escribe, no antes.** Un fichero de 10 MiB no se
   carga en memoria para hashearlo. `InspectingStream` es un `Transform`
   que calcula SHA-256, cuenta bytes, guarda los primeros 16 para las firmas
   y busca NUL en los primeros 8 KiB **mientras** los bytes pasan al
   proveedor. Si al final algo falla, se borra el objeto que ya se escribió.
   Orden importante: escribir primero y validar después es correcto porque el
   objeto rechazado nunca llega a tener fila en la base de datos.
4. **Dos validaciones que parecen una.** Extensión en la allow-list **y** MIME
   compatible con esa extensión **y** firma binaria coherente. `evil.exe`
   renombrado a `foto.png` pasa la primera, quizá la segunda (el navegador
   dice `image/png` porque confía en la extensión) y muere en la tercera.
   La allow-list vive en `packages/shared` porque el cliente la usa para
   rechazar antes de subir; pero el que decide es el servidor.
5. **El límite lo aplica el parser, el error lo pone el servicio.**
   `@fastify/multipart` con `throwFileSizeLimit: false` corta el stream en
   `UPLOAD_MAX_SIZE_BYTES` y marca `truncated`. El servicio lo lee y responde
   `FILE_TOO_LARGE` con el límite en el mensaje. Alternativa descartada:
   dejar que el plugin lance su propio error, que llegaría al filtro con una
   forma distinta a la del resto del dominio.
6. **`wx` y no `w`.** Las keys son de un solo uso; si `put` encuentra el
   fichero, algo va mal arriba y sobrescribir evidencia en silencio sería
   peor que un 503. El detalle que costó un test: al fallar con `EEXIST`, la
   limpieza del "fichero parcial" **no** debe borrar el fichero que ya estaba.
7. **Descarga = autorización + stream, sin URL pública.** No hay pre-signed
   URLs todavía; el navegador pide `GET /attachments/:id/content` con el
   token y la organización, y la API responde con `X-Content-Type-Options:
nosniff`, `Cache-Control: private, no-store` y un `Content-Disposition`
   que solo permite `inline` a imágenes y PDF. Un `.txt` servido inline con
   un MIME adivinado es el principio de un XSS almacenado.
8. **Borrar físico primero, lógico después.** Si el proveedor falla, la fila
   sigue activa y se puede reintentar. Al revés, una fila marcada `deletedAt`
   con el fichero aún en disco es un objeto huérfano que nadie volverá a
   ver. El `delete` del proveedor es idempotente precisamente para que el
   reintento sea seguro.
9. **El mock de memoria es un proveedor de pleno derecho.** Cumple el mismo
   contrato (el mismo fichero de tests corre contra ambos) y añade
   `failNext('put')` para que el test de "el proveedor falla" no dependa de
   permisos de disco ni de `vi.spyOn` sobre internals. Lo que no debe pasar:
   que un despliegue lo elija por error — `STORAGE_PROVIDER=memory` es una
   opción válida del enum y esa comodidad es la deuda 33.
10. **En el cliente, `FormData` sin `Content-Type`.** El `boundary` lo pone
    el navegador; si `apiFetch` lo fija a mano, la subida se rompe de forma
    difícil de diagnosticar. Y la descarga usa `apiFetchBlob`: mismo token,
    mismo refresh en 401, cuerpo como `Blob` → `URL.createObjectURL` para la
    preview, revocado al cerrar.

## Comandos

```bash
cd apps/api && npx vitest run src/integrations/noop.providers.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts test/integration-settings.int-spec.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts test/external-traceability.int-spec.ts
cd packages/shared && npx vitest run src/integrations
```

## Errores comunes

**Diseñar el puerto después del primer adaptador.** Queda con su forma.

**Stubs que devuelven datos plausibles.** El fallo se descubre en producción.

**Columnas específicas del proveedor en las tablas del dominio.** `jiraIssueKey`
en `Defect` es una migración por cada proveedor nuevo.

**Guardar el token en `IntegrationConnection`.** Un backup se convierte en una
filtración.

**Registrar el cuerpo de los emails.** Los tokens acaban en los logs.

**Inyectar la clase en vez de un token.** Cambiar de proveedor toca todo el
código que lo usa.

**Empezar por webhooks.** Superficie pública antes de tener firma y replay
protection.

## Preguntas de repaso

1. ¿Por qué el puerto se escribe antes que el primer adaptador?
2. ¿Por qué los noop de escritura fallan y los de lectura devuelven vacío?
3. ¿Qué se gana guardando `secretRef` en lugar del secreto?
4. ¿Qué evita `ExternalReference` frente a una columna por proveedor?
5. ¿Por qué la ingesta de CI es pull y no webhook en el MVP?
6. ¿Qué habría que resolver antes de aceptar un webhook?

## Ejercicios

1. Implementa un `FakeIssueTrackerAdapter` en memoria y úsalo para probar el
   flujo de exportar un defecto de punta a punta.
2. Añade `POST /integrations/connections/:id/check` que llame a `check()` y
   guarde `status` y `lastError`.
3. Diseña la resolución de `secretRef` con dos backends: variables de entorno en
   desarrollo y un gestor de secretos en producción.
4. Escribe el mapeo de severidad de qa-flow-hub a prioridad de Jira y decide qué
   ocurre con los valores que no encajan.
5. Diseña la ingesta de resultados de Playwright: cómo se enlaza un nombre de
   test con un `TestCase` y qué se hace con los que no enlazan.

## Qué diría en una entrevista

> Escribo los puertos antes que cualquier adaptador, porque una interfaz
> diseñada después del primer proveedor acaba con su forma y el segundo hay que
> reescribirlo. Los proveedores noop fallan de manera explícita en vez de
> devolver datos falsos: un stub que dice «creado JIRA-123» hace creer al código
> que la integración funciona y el fallo aparece en producción. Los secretos se
> guardan como referencia, no como valor, y las relaciones externas viven en una
> tabla `ExternalReference` genérica, así que integrar Jira será añadir un
> adaptador y cambiar un token de inyección, no migrar el esquema.

## MVP frente a futuro

| Decisión       | Ahora                                     | Después                                    |
| -------------- | ----------------------------------------- | ------------------------------------------ |
| Proveedores    | Jira mock (S2-F2); TestRail y GitHub noop | Jira real, TestRail, GitHub Actions        |
| Secretos       | Campo `secretRef` sin resolver            | Gestor de secretos real                    |
| Ingesta de CI  | Pull                                      | Webhooks firmados                          |
| Sincronización | Unidireccional y bajo demanda (botón)     | Bidireccional con resolución de conflictos |
| Reintentos     | No hay                                    | Cola con backoff y cola de fallos          |
| Email          | Noop que registra y no envía              | Proveedor transaccional real               |

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

## Comandos

```bash
cd apps/api && npx vitest run src/integrations/noop.providers.test.ts
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

| Decisión | Ahora | Después |
| --- | --- | --- |
| Proveedores | Solo noop | Jira, TestRail, GitHub Actions |
| Secretos | Campo `secretRef` sin resolver | Gestor de secretos real |
| Ingesta de CI | Pull | Webhooks firmados |
| Sincronización | Unidireccional al diseñar | Bidireccional con resolución de conflictos |
| Reintentos | No hay | Cola con backoff y cola de fallos |
| Email | Noop que registra y no envía | Proveedor transaccional real |

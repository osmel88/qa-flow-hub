# 42 — Billing y suscripciones: el plan como consecuencia de un pago

## Concepto

Hasta S2-F10, `Organization.plan` era un campo más: un owner podía enviar
`PATCH /organizations/current { "plan": "business" }` y obtener el plan más
caro sin pagar. En un SaaS el plan no es un dato que edita el cliente, sino
**la consecuencia de una suscripción** que confirma un proveedor de pagos.

S2-F11 separa tres cosas que suelen mezclarse:

1. **El catálogo**: qué planes existen y qué límites dan. Es código, no datos.
2. **La suscripción**: en qué estado está el contrato con el proveedor
   (`trialing`, `active`, `past_due`, `canceled`, `incomplete`).
3. **El plan efectivo**: qué límites aplicamos _ahora mismo_, calculado a partir
   de la suscripción y del reloj.

Código de referencia:

- `packages/shared/src/billing/billing.contracts.ts` — catálogo y `resolveEffectivePlan`.
- `apps/api/src/modules/billing/billing-provider.ts` — el puerto `BillingProvider`.
- `apps/api/src/modules/billing/mock/mock-billing.provider.ts` — el proveedor mock.
- `apps/api/src/modules/billing/webhook-signature.ts` — firma y verificación HMAC.
- `apps/api/src/modules/billing/billing-webhooks.service.ts` — aplicar webhooks.
- `apps/api/src/modules/billing/usage-limits.service.ts` — límites con advisory lock.
- `apps/api/prisma/migrations/20261011100000_billing/migration.sql` — tablas y RLS.
- ADR `docs/adr/0015-billing-provider.md`.

## El plan efectivo es una función pura

```ts
resolveEffectivePlan(subscription, now, graceDays) → { plan, reason }
```

- Sin suscripción → `free` (`no_subscription`).
- `trialing` con `trialEndsAt > now` → el plan del trial; si ya pasó → `free`
  (`trial_expired`).
- `active` dentro del periodo → el plan pagado.
- `past_due` → el plan pagado durante `graceDays` desde `pastDueSince`; después
  → `free`.
- `canceled` o `incomplete` → `free`.

Como el reloj es un parámetro, los tests prueban cada frontera sin esperar
14 días. Y como el plan se **recalcula al leer**, no hace falta un job que
"caduque" trials a medianoche: si el job falla, el sistema no queda en un estado
incorrecto, porque no hay job. `Organization.plan` sigue existiendo como caché
para listados, pero solo la escribe el módulo de billing.

**Pregunta de entrevista:** ¿por qué no guardar el plan efectivo y actualizarlo
con un cron? Porque entonces hay dos fuentes de verdad y una ventana en la que
discrepan. Derivar es más barato que sincronizar.

## Puertos y adaptadores, otra vez

El servicio no conoce Stripe. Habla con un puerto:

```ts
interface BillingProvider {
  createCustomer(...); createCheckoutSession(...); changePlan(...);
  cancelAtPeriodEnd(...); resume(...);
  parseWebhook(rawBody, headers, now): BillingEvent;
}
```

El mock implementa el puerto en memoria y emite los mismos webhooks firmados
que emitiría un proveedor real, por el mismo endpoint público. Así los tests de
integración y el E2E recorren el camino completo — checkout, webhook, factura —
sin red y sin cuenta en ningún proveedor. Cambiar a Stripe será una clase nueva.

Producción **no arranca** con `BILLING_PROVIDER=mock` (`billing-startup.ts`): es
la misma idea de "fallar cerrado" del capítulo 41.

## Webhooks: autenticar bytes, no JSON

Un webhook es una petición pública, sin sesión. Lo único que prueba que viene
del proveedor es la firma:

```text
x-qaflow-signature: t=<unix>,v1=<hex HMAC-SHA256 de "<t>.<raw body>">
```

Tres detalles importan:

1. **La firma cubre el cuerpo crudo.** Si verificáramos tras `JSON.parse` y
   volver a serializar, un espacio o el orden de las claves cambiarían el
   resultado. Por eso `configure-app.ts` guarda `rawBody` solo en esa ruta.
2. **El timestamp entra en la firma** y se exige una tolerancia de 300 s: un
   atacante que capture un webhook no puede reenviarlo mañana.
3. **Comparación en tiempo constante** (`timingSafeEqual`), para no filtrar
   cuántos bytes coinciden.

Después de verificar:

- **Deduplicación:** se inserta `billing_webhook_events(provider, externalEventId)`
  con restricción única _en la misma transacción_ que aplica el cambio. Si el
  proveedor reintenta, el insert choca (`P2002`) y la respuesta es `duplicate`.
- **El tenant no viene del payload.** Un evento dice `externalCustomerId`; la
  organización sale de nuestra tabla `billing_customers`. Un campo
  `organizationId` inyectado en el JSON es rechazado por el esquema estricto.
- **Cliente desconocido:** el evento se registra (para que el replay siga siendo
  `duplicate`) y no se aplica a nadie.

**Ejercicio:** ¿qué pasaría si la deduplicación se hiciera _antes_ de la
transacción que aplica el cambio, en otra transacción? (Pista: un fallo entre
ambas pierde el evento para siempre.)

## Webhooks fuera de orden y carreras

Los proveedores no garantizan el orden. Cada suscripción y cada factura guarda
`lastEventAt`, el `createdAt` del evento más nuevo aplicado; un evento más viejo
se registra (para deduplicar) pero no cambia nada. Esa comparación es otro
_check-then-act_: dos webhooks simultáneos leerían el mismo `lastEventAt` y el
viejo podría escribir el último. Por eso `apply()` toma primero
`pg_advisory_xact_lock('billing:<org>:state')`, y la cancelación local de un
trial usa el mismo lock con un `UPDATE ... WHERE status = 'trialing'`: si un
checkout se confirmó entretanto, la cancelación no lo pisa.

La revisión de S2-F11 encontró estas carreras con tests que fallaban antes del
arreglo (`billing.int-spec.ts`, bloque _review_), igual que un segundo checkout
pagado sobre una suscripción ya activa o cuatro upgrades simultáneos que
generaban cuatro facturas.

## Límites bajo concurrencia

"Free permite 3 proyectos" parece un `if (count >= 3) throw`. Con dos peticiones
simultáneas y 2 proyectos, ambas cuentan 2, ambas pasan y quedan 4. Es el
clásico _check-then-act_.

`UsageLimitsService.guard()` abre una transacción, toma
`pg_advisory_xact_lock` sobre (organización, recurso), cuenta, compara con el
plan efectivo y ejecuta la escritura **dentro de la misma transacción**. El lock
se libera solo al hacer commit o rollback. Las peticiones de una organización se
admiten de una en una; las de otras organizaciones no se bloquean entre sí.

Al superar un límite se devuelve `402 PLAN_LIMIT_REACHED` y **no se borra nada**:
un downgrade puede dejar a una organización por encima del límite; sigue viendo
y usando lo que tiene, pero no puede crear más.

## RLS en tablas de billing

Las cuatro tablas tienen RLS como el resto. El caso interesante es
`billing_webhook_events`: un evento de un cliente desconocido no tiene
organización. La política solo permite `organizationId IS NULL` cuando **no hay**
contexto de tenant activo; con un tenant activo no se puede escribir un evento
"huérfano" que escape al aislamiento.

## Permisos

- Owner y admin leen plan, uso y facturas.
- Solo el owner hace checkout, cambia plan, cancela o reanuda.
- El resto de roles recibe 403, y la UI ni siquiera lanza la consulta.
- Cada cambio queda en el audit log.

## Frontend

- La página `/billing` muestra el plan efectivo, el estado, medidores de uso
  (aviso al 80 %) y facturas paginadas.
- Las query keys incluyen la organización activa, así que al cambiar de tenant
  nunca se ve el billing del anterior.
- Crear un proyecto, invitar o subir un fichero invalida `['billing']`; si no, el
  medidor mostraría el uso anterior durante el `staleTime`.
- Un 402 se muestra con `PlanLimitAlert`, que explica que no se eliminó nada.

## Qué queda fuera

Proveedor real, impuestos, prorrateo, cupones, dunning por email y retención de
eventos: ver la deuda 37 en `docs/technical-debt.md`.

## Ejercicios

1. Añade un plan `enterprise` al catálogo. ¿Qué tests fallan y por qué?
2. Escribe un test que demuestre que con 2 huecos libres, 5 creaciones
   simultáneas de proyectos producen exactamente 2 éxitos.
3. Diseña el adaptador de Stripe: ¿qué eventos de Stripe mapearías a
   `subscription.updated` e `invoice.updated`?

# 28 — Pruebas unitarias

## Concepto

Una prueba unitaria ejercita una pieza de lógica **sin base de datos, sin red y
sin arrancar Nest**. Entra un valor, sale otro, y la prueba tarda milisegundos.

En este proyecto son deliberadamente pocas. No por pereza: la mayoría de las
reglas de qa-flow-hub no son cálculos, son *invariantes sobre datos* —que una
organización no vea la fila de otra, que una transición de estado sea legal, que
una clave `WEB-C-7` no se repita—. Esas se prueban contra PostgreSQL real, en el
capítulo 29. Aquí viven las que sí son funciones puras.

## Qué problema resuelve

Dos problemas concretos, no «calidad» en abstracto:

1. **Documentar el borde de una función.** `parseDuration('1w')` ¿es una semana o
   un error? La prueba responde en un renglón y no se desactualiza.
2. **Hacer barato el caso raro.** Generar 500 tokens para comprobar que ninguno
   se repite, o recorrer una docena de duraciones inválidas con `it.each`, cuesta
   milisegundos; hacerlo arrancando la aplicación costaría minutos y nadie lo
   escribiría.

## Archivos reales

```
apps/api/src/config/env.schema.test.ts                              el arranque falla sin secretos
apps/api/src/modules/auth/token.service.test.ts                     parseDuration
apps/api/src/modules/auth/guards/roles.guard.test.ts                jerarquía de roles
apps/api/src/modules/organizations/organization-invitations.repository.test.ts  tokens de invitación
apps/api/src/integrations/noop.providers.test.ts                    los noop fallan
```

Conviven con el código que prueban (`*.test.ts` al lado del `.ts`), mientras las
de integración están aparte en `apps/api/test/*.int-spec.ts`. La separación no es
estética: son dos comandos, dos configuraciones y dos velocidades. `npm run test`
debe poder ejecutarse cien veces al día sin PostgreSQL levantado.

## Qué se prueba aquí y por qué exactamente eso

### Duraciones: fallar al arrancar en vez de elegir por ti

```ts
it.each(['', '15', 'm', '15 minutes', '1w', '-5m', '1.5h'])(
  'refuses the unsupported duration %j',
  (input) => {
    expect(() => parseDuration(input)).toThrow(/Unsupported duration/);
  },
);
```

Lo que fija esta prueba no es el formato, es la **política**: ante `'15 minutes'`
el sistema no aplica un valor por defecto, se niega a arrancar. Un access token
con una vida que nadie eligió es un fallo de seguridad invisible; un proceso que
no arranca es un fallo visible en el primer despliegue.

### Configuración: el esquema como contrato de despliegue

`env.schema.test.ts` comprueba que faltar un secreto, o tener uno demasiado
corto, aborta el arranque. Es la prueba que evita el incidente clásico: la
aplicación levanta en producción con `JWT_ACCESS_SECRET=changeme` porque la
variable no llegó al contenedor.

### Roles: la jerarquía, no la lista

El guard no compara roles por igualdad, compara **rango**:

```ts
const ROLE_RANK: Record<OrganizationRole, number> = {
  organization_owner: 0,
  organization_admin: 1,
  project_manager: 2,
  qa_lead: 3,
  tester: 4,
  viewer: 5,
};
```

La prueba unitaria fija que un `organization_owner` pasa un requisito de
`qa_lead` sin que nadie tenga que enumerar los seis roles en cada decorador. Con
comparación por igualdad, añadir un rol obligaría a revisar todos los endpoints.

### Tokens de invitación: determinismo a propósito

```ts
it('hashes deterministically, which is what makes lookup by token possible', () => {
  const { token, tokenHash } = issueInvitationToken();
  expect(hashInvitationToken(token)).toBe(tokenHash);
});
```

Parece trivial y es la prueba más informativa del archivo: fija que el hash de
invitación **es** determinista, al contrario que el de contraseñas. Si alguien
«mejora» esto poniendo Argon2, aceptar una invitación pasa a ser un recorrido de
toda la tabla y esta prueba lo dice antes que el usuario. El razonamiento está en
el capítulo 12: el token tiene 256 bits de entropía, así que no hay diccionario
que atacar.

Las otras cuatro del archivo fijan el resto del contrato del token: 43 caracteres
`base64url` (nada que escapar en una URL), 500 emisiones sin una repetición, un
hash del que no se puede leer el token, y comparación en tiempo constante con
`hashesMatch` para que el propio endpoint de aceptación no filtre el hash por
tiempo.

### Los noop, otra vez

```ts
await expect(adapter.createIssue(context, payload)).rejects.toThrow(
  IntegrationNotConfiguredError,
);
```

Prueba una **decisión de diseño**, no un cálculo: la escritura no configurada
falla en vez de devolver `JIRA-123`.

## Cómo aíslo sin librería de mocks

No hay `jest.mock`, ni `sinon`, ni contenedor de inyección falso. Donde hace
falta sustituir una dependencia, se sustituye a mano:

```ts
reflector.getAllAndOverride = ((key: string) =>
  key === ROLES_KEY ? roles : undefined) as unknown as Reflector['getAllAndOverride'];
```

Es más feo y es intencionado. Un mock automático de `Reflector` obligaría a
mantener la forma completa de una clase de Nest en la prueba; esta línea declara
exactamente la única cosa de la que depende el guard. Cuando una prueba unitaria
necesita cinco mocks, el mensaje no es «faltan mocks», es que la unidad tiene
demasiadas dependencias y esa lógica pertenece a un servicio con prueba de
integración.

## Comandos

```bash
npm run test                       # todos los workspaces
cd apps/api && npm run test        # solo la API, sin PostgreSQL
cd apps/api && npm run test:watch  # bucle de desarrollo
npx vitest run src/modules/auth    # una carpeta
npx vitest run -t 'duration'       # por nombre de prueba
```

Con Vitest y `unplugin-swc`, no hay compilación previa a `tsc`: la suite
unitaria de la API termina en menos de un segundo.

## Errores comunes

**Perseguir cobertura en los controladores.** Un controlador que solo delega no
tiene nada que probar en unitario; su valor está en la ruta, el guard y la
validación, y eso solo se ve por HTTP.

**Mockear Prisma para probar un servicio.** Se acaba probando que el mock
devuelve lo que el mock devuelve. El error real —un `where` sin
`organizationId`— es justo el que el mock no puede ver.

**Pruebas que dependen del reloj.** `expiresAt` calculado con `Date.now()` real
falla un día a las 23:59. Se inyecta el instante o se comprueba el intervalo.

**Aserciones sobre el mensaje exacto de un error.** Cambiar una coma rompe la
prueba. Se afirma el tipo o un patrón (`/Unsupported duration/`).

**Un `expect` por prueba como dogma.** Varias aserciones sobre el mismo hecho
son una prueba; varias sobre hechos distintos son varias pruebas.

**Escribir la prueba después de ver el fallo en producción.** Lo que reproduce el
incidente entra como prueba en el mismo commit que la corrección.

## Preguntas de repaso

1. ¿Por qué este proyecto tiene pocas pruebas unitarias y muchas de integración?
2. ¿Qué política —no qué formato— fija la prueba de `parseDuration`?
3. ¿Por qué el hash de invitación debe ser determinista y el de contraseña no?
4. ¿Qué haría mal una prueba unitaria de un servicio con Prisma mockeado?
5. ¿Por qué el guard compara rangos de rol y no igualdad?
6. ¿Qué te está diciendo una prueba unitaria que necesita cinco mocks?

## Ejercicios

1. Añade casos a `parseDuration` para `'0s'` y `'999d'` y decide, con argumento
   escrito, si son válidos.
2. Extrae la validación de transiciones de estado de defectos a una función pura
   y cúbrela con `it.each` sobre las 7 × 7 combinaciones.
3. Escribe una prueba unitaria de la construcción de claves legibles
   (`WEB-C-7`) que no toque la base de datos.
4. Introduce a mano un fallo en `ROLE_RANK` (intercambia `tester` y `qa_lead`) y
   comprueba qué pruebas se ponen rojas. Si no se pone ninguna, escribe la que
   falta.
5. Mide con `npx vitest run --coverage` qué queda sin cubrir y decide qué de eso
   *no* merece una prueba unitaria, justificándolo.

## Qué diría en una entrevista

> Uso pruebas unitarias para lógica pura —parseo de duraciones, validación de
> configuración, jerarquía de roles, hashing— y no para reglas que dependen de la
> base de datos. Mockear Prisma para probar un servicio multi-tenant es
> contraproducente: el error que quiero atrapar es un `where` sin
> `organizationId`, y un mock lo acepta encantado. Esas reglas van a pruebas de
> integración contra PostgreSQL real. Y mantengo las dos suites en comandos
> separados para que la unitaria siga siendo instantánea y se ejecute de verdad.

## MVP frente a futuro

| Decisión | Ahora | Después |
| --- | --- | --- |
| Runner | Vitest con SWC | Igual |
| Ubicación | `*.test.ts` junto al código | Igual |
| Mocks | A mano, mínimos | Igual; si crecen, la unidad está mal cortada |
| Umbral de cobertura | Sin puerta en CI | Umbral en las carpetas de dominio |
| Property-based testing | No hay | `fast-check` para claves y transiciones |
| Mutation testing | No hay | Stryker sobre `src/modules` para medir la suite |

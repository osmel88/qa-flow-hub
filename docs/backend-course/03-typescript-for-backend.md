# 03 — TypeScript para backend

## Concepto

TypeScript añade un sistema de tipos que se verifica en tiempo de compilación y
**desaparece en tiempo de ejecución**. Esa frase es la clave de todo el
capítulo: los tipos no validan datos de entrada. Un `req.body as CreateProjectDto`
no comprueba nada; es una promesa que le haces al compilador y que el usuario
puede romper.

De ahí la división que usa este backend:

- **TypeScript** protege los límites *internos* (una función llama a otra).
- **Zod** protege los límites *externos* (HTTP, variables de entorno).

## Qué problema resuelve

En un backend, la mayoría de los errores en producción son de forma: un campo
que a veces es `null`, un enum que creció, una función que devuelve `undefined`
en una rama. Con tipos estrictos, el compilador te obliga a tratar esas ramas
*antes* de desplegar. El coste es que a veces pelea contigo; el beneficio es que
la pelea ocurre en tu máquina y no en la del cliente.

## La configuración estricta, opción por opción

Está en
[`packages/config/tsconfig.base.json`](../../packages/config/tsconfig.base.json)
y la heredan todos los paquetes.

| Opción | Qué te obliga a hacer |
| --- | --- |
| `strict` | Activa el paquete completo: `strictNullChecks`, `noImplicitAny`, etc. |
| `noUncheckedIndexedAccess` | `array[0]` pasa a ser `T \| undefined`. Te obliga a comprobar antes de usar. |
| `noImplicitOverride` | Sobrescribir un método de la clase padre requiere `override`. Evita el "creía que sobrescribía". |
| `noImplicitReturns` | Todas las ramas de una función devuelven valor. |
| `noFallthroughCasesInSwitch` | Un `case` sin `break` es un error, no una intención. |
| `noUnusedLocals` / `noUnusedParameters` | Código muerto no compila. |
| `noPropertyAccessFromIndexSignature` | `env.PORT` no compila si el tipo es un índice; hay que escribir `env['PORT']`. Hace visible que el acceso puede no existir. |
| `useUnknownInCatchVariables` | En `catch (e)`, `e` es `unknown`. Te obliga a estrechar el tipo antes de leer `.message`. |

**`exactOptionalPropertyTypes`, y por qué la predicción era falsa.** Distingue
entre "la propiedad no está" y "la propiedad vale `undefined`". Se dejó
desactivado con un argumento razonable —Prisma y Zod modelan los opcionales como
`T | undefined`, activarlo generaría ruido sin detectar nada— y al activarlo
salieron **6 errores en todo el monorepo**, cuatro de ellos reales:

```ts
// Antes: undefined significaba "usa la política por defecto de helmet"...
await app.register(import('@fastify/helmet'), {
  contentSecurityPolicy: config.isProduction ? undefined : false,
});

// ...pero un plugin que comprueba la presencia de la clave ve algo distinto.
await app.register(import('@fastify/helmet'), {
  ...(config.isProduction ? {} : { contentSecurityPolicy: false }),
});
```

En Prisma la diferencia sale más caro: `where: { status: undefined }` **no filtra
nada**, así que un opcional mal propagado no da error, devuelve más filas.

La lección de ingeniería no es "actívalo siempre": es que **una decisión anotada
con una predicción se puede comprobar**. El coste real fue de 6 errores porque el
código ya usaba el patrón `...(x === undefined ? {} : { x })`; el flag convierte
esa convención en una regla del compilador en lugar de una costumbre.

## Lint con información de tipos

`tsc` y ESLint no ven lo mismo. Estas tres son válidas para el compilador:

```ts
save(entity);                       // Promise flotante: nadie espera el fallo
if (status === HttpStatus.CONFLICT) // number contra enum: nunca coincide
String(requestBody)                 // "[object Object]", y el test pasa
```

Ninguna es un error de tipos, y las tres son defectos. Por eso
[`packages/config/eslint.base.js`](../../packages/config/eslint.base.js) usa
`recommendedTypeChecked` con `projectService: true`, que deja que cada fichero
encuentre su propio `tsconfig` —lo que hace viable el monorepo sin enumerar
proyectos a mano—.

Al activarlo aparecieron 822 errores, y **780 eran el mismo hecho repetido**:
`response.json()` devuelve `any` en la suite de integración. Ahí la familia
`no-unsafe-*` está desactivada a propósito, porque el cuerpo de una respuesta HTTP
**es** un dato sin tipo: poner 780 aserciones de tipo que nadie ha verificado se
parece a seguridad sin serlo. La versión que sí valdría la pena es validar las
respuestas con los contratos Zod compartidos, que las tipa *y* detecta deriva del
contrato; queda anotado en [`../technical-debt.md`](../technical-debt.md).

## El caso especial de NestJS

Dos opciones existen solo por los decoradores:

```jsonc
// apps/api/tsconfig.json
"experimentalDecorators": true,
"emitDecoratorMetadata": true,
"strictPropertyInitialization": false
```

`emitDecoratorMetadata` hace que el compilador emita, junto a cada clase
decorada, los **tipos de los parámetros del constructor**. Nest lee esa metadata
para saber qué inyectar. Si la desactivas, cada dependencia necesitaría un
`@Inject(TOKEN)` explícito.

Consecuencia práctica y poco intuitiva: **no uses `import type` para algo que
aparece en un constructor inyectado**. Un `import type` se borra al compilar, la
metadata queda vacía y Nest falla en tiempo de ejecución con
`Nest can't resolve dependencies of ...`. Por eso
[`packages/config/eslint.base.js`](../../packages/config/eslint.base.js) deja la
regla `consistent-type-imports` desactivada: forzarla rompería la inyección.

## Código real

Tipar la configuración en lugar de leer cadenas sueltas
([`apps/api/src/config/app-config.service.ts`](../../apps/api/src/config/app-config.service.ts)):

```ts
private get<K extends keyof Env>(key: K): Env[K] {
  return this.config.get(key, { infer: true });
}
```

`K extends keyof Env` hace que `this.get('PORT')` devuelva `number` y que
`this.get('PROT')` no compile. Es un genérico de tres palabras que elimina toda
una clase de errores de configuración.

Tipos derivados de un valor, no duplicados
([`packages/shared/src/common/api-error.ts`](../../packages/shared/src/common/api-error.ts)):

```ts
export const API_ERROR_CODES = ['VALIDATION_ERROR', 'UNAUTHENTICATED', /* ... */] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
```

El `as const` congela el array en una tupla de literales, y el tipo se deriva de
él. Hay **una sola fuente**: añadir un código al array lo añade al tipo y al
esquema Zod a la vez. La alternativa (un `type` y un array separados) se
desincroniza el día que tengas prisa.

Tipos discriminados por clase, en la jerarquía de errores
([`apps/api/src/errors/domain-error.ts`](../../apps/api/src/errors/domain-error.ts)):

```ts
export abstract class DomainError extends Error {
  abstract readonly code: ApiErrorCode;
  abstract readonly httpStatus: number;
}
```

Cada subclase declara `readonly code = 'NOT_FOUND' as const`. El `as const` es lo
que impide que el tipo se ensanche a `string` y permite que el filtro de
excepciones lo use con seguridad.

## Comandos

```bash
npm run typecheck                     # tsc --noEmit en todos los paquetes
npm run typecheck -w @qa-flow-hub/api # solo la API
npx tsc -p apps/api/tsconfig.json --noEmit --explainFiles | head  # qué ficheros entran
```

## Errores comunes

- **`Object is possibly 'undefined'` tras activar `noUncheckedIndexedAccess`.**
  No lo silencies con `!`. Comprueba, o usa `at()` con guarda. El error tiene
  razón: ese índice puede no existir.
- **`Property 'PORT' comes from an index signature`.** Es
  `noPropertyAccessFromIndexSignature`. Escribe `process.env['PORT']`.
- **`Nest can't resolve dependencies of the X (?)`.** Casi siempre es un
  `import type` en una dependencia inyectada, o un módulo que no exporta el
  proveedor.
- **Creer que un `as` valida.** `body as CreateProjectDto` compila con cualquier
  basura. Solo Zod valida.
- **`any` para salir del paso.** Está prohibido por ESLint
  (`@typescript-eslint/no-explicit-any: error`). Si no sabes el tipo, es
  `unknown` y lo estrechas; `any` desactiva el compilador justo donde más lo
  necesitas.

## Preguntas de repaso

1. ¿Por qué un `as` no protege frente a un cuerpo HTTP malicioso?
2. ¿Qué hace `emitDecoratorMetadata` y por qué `import type` puede romper la
   inyección de dependencias?
3. ¿Qué gana `API_ERROR_CODES` al declararse con `as const`?
4. ¿Qué obliga a hacer `noUncheckedIndexedAccess` en un `for` sobre un array?

## Ejercicios

1. Añade un código nuevo a `API_ERROR_CODES` y comprueba, sin ejecutar nada, qué
   otros ficheros deja de compilar el proyecto. Explica por qué es una buena
   señal.
2. Quita `noUncheckedIndexedAccess` de la configuración base y cuenta cuántos
   errores desaparecen. Vuelve a activarlo y arregla uno a mano.
3. Escribe una función `assertNever(value: never): never` y úsala en el `switch`
   de `codeForStatus` para que añadir un código nuevo sin tratarlo no compile.

## Qué diría en una entrevista

> "Uso TypeScript en modo estricto para los límites internos y Zod para los
> externos, porque los tipos se borran al compilar y no validan nada en
> ejecución. En NestJS hay una trampa concreta: `emitDecoratorMetadata` necesita
> importaciones de valor, así que forzar `import type` rompe la inyección de
> dependencias en tiempo de ejecución aunque el proyecto compile."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Linting con tipos | Desactivado (el `tsc` estricto ya cubre) | `recommendedTypeChecked` para detectar promesas sin `await` |
| `exactOptionalPropertyTypes` | Activado | — |
| Lint con tipos | `recommendedTypeChecked` | `no-unsafe-*` apagado en los tests hasta validar respuestas con Zod |

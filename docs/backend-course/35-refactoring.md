# 35 — Refactorización

## Concepto

Refactorizar es cambiar la forma sin cambiar el comportamiento. La segunda mitad
de la frase es la que cuesta: **sin una red que te diga que el comportamiento no
cambió, no estás refactorizando, estás reescribiendo y esperando**. En este
repositorio la red son 226 pruebas de integración y 71 unitarias, y por eso los
capítulos 28 y 29 vienen antes que este.

Este capítulo no explica teoría de *code smells*: recorre los refactores que
**este** código ha sufrido de verdad, con lo que los disparó.

## Qué problema resuelve

Un refactor no se hace porque el código sea "feo". Se hace cuando aparece una de
estas cuatro señales, todas objetivas:

| Señal | Ejemplo real aquí |
| --- | --- |
| La misma regla existe en dos sitios y pueden divergir | La jerarquía de roles estaba en la API y duplicada en el cliente |
| Un cambio pequeño obliga a tocar N archivos | Cablear RLS habría exigido tocar 18 repositorios |
| Añadir una función crea un ciclo de dependencias | Purgar enlaces de trazabilidad desde cuatro módulos |
| El código miente sobre lo que hace | Un `switch` que parecía exhaustivo y cuyos `case` no coincidían nunca |

## Caso 1: la regla duplicada — mover a `packages/shared`

**Síntoma.** La pantalla de miembros mostraba controles que la API rechazaba
después con un `403`. Había dos jerarquías de roles: la del servidor, que decide, y
la del cliente, que adivinaba.

**Refactor.** Mover la jerarquía a `packages/shared` y que ambos lados lean **una
sola definición**. El cliente deja de adivinar y la API sigue siendo la única que
decide.

**Lo que enseña:** duplicar una constante es barato; duplicar una **regla** es una
divergencia futura garantizada. La pregunta para distinguirlas: si esto cambia,
¿los dos sitios tienen que cambiar a la vez? Si sí, es una sola regla en dos
archivos.

Y el efecto secundario que justifica el trabajo: al escribir la jerarquía una vez,
apareció que `invitations.service` no comprobaba rango, así que un admin podría
haber invitado a un owner y quedar por debajo de su propio invitado.

## Caso 2: el cambio que habría tocado 18 archivos — mover el punto de unión

**Síntoma.** Para activar RLS hacía falta que cada consulta anunciase la
organización activa dentro de su transacción. La versión directa: cambiar los 18
repositorios.

**Refactor.** Un solo punto: la clase base ya era la única puerta a Prisma, así que
basta con que su getter devuelva el cliente extendido.

```ts
export abstract class TenantAwareRepository {
  protected constructor(
    private readonly prismaService: PrismaService,
    protected readonly tenant: TenantContextService,
  ) {}

  protected get prisma(): RlsPrismaClient {
    return this.prismaService.scoped;
  }
}
```

Ningún repositorio cambió, y —más importante— **ninguno puede elegir el cliente sin
protección**, porque no tiene acceso a él.

**Lo que enseña:** el valor de una clase base no es reutilizar código, es tener
**un sitio donde cambiar de opinión**. Cuando un cambio transversal se resuelve en
un archivo, es porque alguien creó ese punto antes de necesitarlo. Cuando exige
tocar 18, la lección es la contraria y llega tarde.

## Caso 3: el ciclo de dependencias — extraer el colaborador mínimo

**Síntoma.** Al borrar un requisito, un caso, un run o un defecto hay que purgar
sus enlaces de trazabilidad en la misma transacción. Si cada uno de esos módulos
importa `TraceabilityModule`, y trazabilidad importa esos módulos para validar los
extremos de un enlace, Nest falla al construir el grafo: `A circular dependency has
been detected`.

**Refactor.** Extraer `TraceabilityLinksRepository` a un módulo mínimo que **no
depende de nadie** y que los cuatro módulos importan. La solución tentadora es
`forwardRef()`, y es la equivocada: hace compilar el ciclo en lugar de eliminarlo,
y deja el orden de inicialización como un detalle que nadie entiende seis meses
después.

**Lo que enseña:** un ciclo de dependencias casi nunca es un problema de
herramientas; es un módulo que aún no existe. La pregunta útil no es "¿cómo rompo
el ciclo?", es "¿qué pieza comparten estos dos módulos y todavía no tiene nombre?".

## Caso 4: el código que miente — la lección más incómoda

```ts
// Antes: leía como exhaustivo, y varios case no podían coincidir nunca
switch (status) {          // status: number
  case HttpStatus.CONFLICT: // HttpStatus: enum
    return 'CONFLICT';
  ...
}
```

**Síntoma.** Nadie lo notó leyéndolo: lo encontró el linter con información de
tipos, en la deuda #5. Comparar un `number` con miembros de un enum es válido para
el compilador y silenciosamente inútil.

**Refactor.** Una tabla `Record<number, ApiErrorCode>` y una búsqueda. Menos código
y sin comparación mixta.

**Lo que enseña:** hay refactores que no se te ocurren; los tiene que encontrar una
herramienta. Es el argumento para subir el suelo (lint con tipos,
`exactOptionalPropertyTypes`) en lugar de confiar en la revisión humana para
detectar lo que ninguna persona lee con atención: los `case` de un `switch` largo.

## Caso 5: cambiar un filtro es cambiar el comportamiento

`locateEntity` usaba `scope()` (filtro de tenant) donde debía usar `active()`
(tenant y no borrado), y por eso se podía crear un enlace hacia una entidad ya
borrada.

Ese **no** es un refactor: cambia el comportamiento, y por eso llegó con tests
nuevos y una entrada de deuda cerrada. Merece estar en este capítulo por el
contraste: la disciplina de refactorizar consiste, sobre todo, en saber en qué
momento dejaste de refactorizar.

## El método, en cinco pasos

1. **Nombra el disparador.** Si no puedes escribirlo en una frase, no refactorices
   todavía: probablemente sea gusto personal.
2. **Comprueba que la red cubre lo que vas a mover.** Si no la hay, el primer
   commit es el test, no el cambio. Un test escrito *después* del refactor
   comprueba el código nuevo, no que el comportamiento se conservó.
3. **Cambia la forma sin cambiar el comportamiento.** Commit aparte, y en el
   mensaje el disparador.
4. **Ejecuta lint, typecheck, tests y build.** En este repositorio son cuatro
   comandos y no son negociables.
5. **Si el refactor destapa un defecto, sepáralo en su propio commit.** Mezclarlos
   hace imposible revertir uno sin el otro, y es la razón por la que un `revert`
   de emergencia a veces reintroduce un bug.

## Errores comunes

- **Refactorizar y arreglar en el mismo commit.** El diff deja de ser revisable y
  el `revert` deja de ser seguro.
- **Usar `forwardRef()` para un ciclo.** Oculta el módulo que falta.
- **Extraer una abstracción con un solo caso de uso.** Dos usos son una
  coincidencia; tres, un patrón. Con uno, es adivinar el futuro.
- **Cambiar un test para que el refactor pase.** Si el comportamiento cambió, no era
  un refactor; nómbralo por lo que es.
- **Mover código entre paquetes sin mirar quién lo importa.** En un monorepo, un
  `import` desde `apps/web` a `apps/api` compila en el editor y rompe el build.

## Preguntas de repaso

1. ¿Cuál es la diferencia entre duplicar una constante y duplicar una regla?
2. ¿Por qué activar RLS solo tocó un archivo de repositorio?
3. ¿Por qué `forwardRef()` es la respuesta equivocada a un ciclo de dependencias?
4. ¿Qué clase de defecto solo encuentra una herramienta y no una revisión humana?
5. ¿Cómo sabes que has dejado de refactorizar y has empezado a cambiar
   comportamiento?

## Ejercicios

1. Busca una regla que siga duplicada entre `apps/web` y `apps/api` y muévela a
   `packages/shared` con un test que la fije. (Pista: los umbrales de "cubierto" y
   "verificado" de la matriz.)
2. Intenta a propósito importar `TraceabilityModule` desde `requirements.module.ts`
   y lee el error de ciclo. Deshaz y explica en una línea qué módulo lo evita.
3. Elige un servicio de más de 300 líneas y extrae una regla de negocio a una
   función pura con su test unitario, **sin** cambiar la suite de integración.
4. Añade una `@@index` que creas necesaria, ejecuta la suite y comprueba que
   ningún test lo nota: un índice es el refactor perfecto, invisible al
   comportamiento.
5. Haz un refactor de dos commits (forma, después defecto) y practica revertir solo
   el segundo.

## Qué diría en una entrevista

> "Refactorizo por un disparador escrito, no por gusto: una regla que existe en dos
> sitios, un cambio que obligaría a tocar veinte archivos, o un ciclo de
> dependencias — que casi siempre significa que falta un módulo, no que haga falta
> `forwardRef`.
>
> El que más me gusta de este proyecto es el de la clase base de repositorio:
> activar Row Level Security exigía que cada consulta anunciase su organización, y
> se resolvió cambiando un getter, porque esa clase ya era la única puerta a
> Prisma. Los dieciocho repositorios no cambiaron y, de paso, ninguno **puede**
> saltarse la protección.
>
> Y una lección incómoda: el linter con tipos encontró un `switch` que parecía
> exhaustivo y cuyos `case` no podían coincidir nunca. Hay defectos que no
> encuentra una revisión humana; para esos, la respuesta es subir el suelo de las
> herramientas, no pedir más atención."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Red de seguridad | 226 integración + 71 unitarias | Cobertura por módulo con umbral en CI |
| Detección | Lint con tipos, revisión manual | Métricas de complejidad y detección de duplicación |
| Ciclos | Módulos mínimos extraídos a mano | Regla de lint de límites entre módulos (`import/no-restricted-paths`) |
| Commits | Forma y defecto separados a mano | Convención comprobada en CI |

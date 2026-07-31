# 06 — Estructura del monorepo

## Concepto

Un monorepo es un único repositorio con varios paquetes que se versionan y
despliegan juntos. Aquí se implementa con **npm workspaces**, que es la función
de espacios de trabajo del propio npm: sin Lerna, sin pnpm, sin Turborepo.

```
apps/api          la API (NestJS)
apps/web          el cliente web (React)
packages/shared   contratos Zod, tipos y enums compartidos
packages/ui       componentes presentacionales accesibles
packages/config   configuración de TypeScript, ESLint y Prettier
docs              documentación de producto y este curso
```

## Qué problema resuelve

El problema concreto es la **deriva de contratos**. En dos repositorios
separados, el backend cambia el nombre de un campo, el frontend se entera en
producción. Aquí el esquema Zod de paginación vive en `packages/shared`, y si el
backend lo cambia, el frontend **deja de compilar en la misma rama y en el mismo
commit**. El error se paga en el pull request, no en el cliente.

Segundo problema: la configuración duplicada. Cuatro paquetes con cuatro
`tsconfig` divergentes es una fuente inagotable de "en mi máquina sí".
`packages/config` es la única fuente.

**Decisión.** Se descartó pnpm + Turborepo. Son mejores en repositorios grandes
(caché de tareas, instalaciones más rápidas), pero añaden una herramienta que
hay que aprender y mantener. Con cinco paquetes, `npm workspaces` basta y el
`README` no necesita explicar nada. Se puede migrar después sin tocar el código.
Ver [`../adr/0005-monorepo-npm-workspaces.md`](../adr/0005-monorepo-npm-workspaces.md).

## Cómo se enlazan los paquetes

En [`apps/api/package.json`](../../apps/api/package.json):

```json
"@qa-flow-hub/shared": "*"
```

El `*` no descarga nada de npm: npm crea un **enlace simbólico** desde
`node_modules/@qa-flow-hub/shared` al directorio del workspace. Editas
`packages/shared/src`, recompilas ese paquete y la API ve el cambio.

## El detalle difícil: ESM y CommonJS

La API compila a **CommonJS** (es lo más simple con los decoradores de Nest y
con Prisma). El frontend consume **ESM** a través de Vite. `packages/shared`
tiene que servir a los dos, y un mismo `.js` no puede ser ambas cosas.

La solución son dos compilaciones y un mapa de exportaciones:

```json
// packages/shared/package.json
"exports": {
  ".": {
    "types": "./dist/esm/index.d.ts",
    "import": "./dist/esm/index.js",
    "require": "./dist/cjs/index.js"
  }
}
```

```json
// scripts del mismo package.json
"build": "tsc -p tsconfig.esm.json && tsc -p tsconfig.cjs.json && node ./scripts/write-module-markers.mjs"
```

El tercer paso existe porque Node decide si un `.js` es ESM o CommonJS mirando
el `type` del `package.json` **más cercano**. Como ambas salidas están dentro de
un paquete cuyo `type` no puede ser las dos cosas, se escribe un marcador en
cada carpeta de salida:

```js
// packages/shared/scripts/write-module-markers.mjs
await writeFile(resolve(dist, 'esm', 'package.json'), '{"type":"module"}\n');
await writeFile(resolve(dist, 'cjs', 'package.json'), '{"type":"commonjs"}\n');
```

Un detalle relacionado: en `packages/shared/src/index.ts` los imports llevan
extensión `.js` aunque los ficheros sean `.ts`:

```ts
export * from './common/pagination.js';
```

No es un error. Es lo que exige la resolución de módulos de Node en ESM, y
funciona igual en la compilación CommonJS.

**`packages/ui` va por otro camino**: se consume como **código fuente**
(`"main": "./src/index.ts"`), sin compilar. Solo lo usa Vite, que compila
TypeScript de todos modos, así que una compilación intermedia sería trabajo sin
beneficio. Su script `build` es un `tsc --noEmit`: verifica, no emite.

## Orden de construcción

```json
// package.json (raíz)
"build": "npm run build -w @qa-flow-hub/shared && npm run build -w @qa-flow-hub/ui && npm run build -w @qa-flow-hub/api && npm run build -w @qa-flow-hub/web"
```

El orden es explícito porque `api` y `web` dependen de `shared`. Con cinco
paquetes, escribirlo a mano es más honesto que instalar un orquestador de tareas
para que lo deduzca.

## Seguridad de la cadena de suministro

npm 11 no ejecuta los scripts de instalación de las dependencias salvo que se
aprueben explícitamente. La lista está en la raíz:

```json
"allowScripts": {
  "@prisma/client": true, "@prisma/engines": true, "@swc/core": true,
  "argon2": true, "esbuild": true, "prisma": true
}
```

Los seis aprobados los necesitan de verdad: compilar bindings nativos o
descargar el motor de consultas. **`@scarf/scarf` no está aprobado**: es
telemetría de instalación y no aporta nada al producto. Es una decisión de
seguridad, no de gusto: cada script aprobado es código de terceros ejecutándose
en tu máquina y en tu CI.

## Comandos

```bash
npm install                                # instala todos los workspaces
npm run build                              # en orden de dependencias
npm run typecheck                          # en todos
npm run test -w @qa-flow-hub/api           # en uno
npm install -w @qa-flow-hub/api argon2     # añadir dependencia a un workspace
npm ls @qa-flow-hub/shared                 # comprobar el enlace
```

## Errores comunes

- **Cambiar `packages/shared` y no verlo en la API.** El paquete se consume
  compilado: hay que ejecutar `npm run build -w @qa-flow-hub/shared` (o dejar
  `npm run dev` en marcha en ese paquete).
- **`ERR_MODULE_NOT_FOUND` con extensión.** Falta el `.js` en un import de
  `packages/shared`.
- **Instalar una dependencia en la raíz por descuido.** `npm install express`
  desde la raíz la pone en el paquete raíz, no en la API. Usa siempre `-w`.
- **Rutas relativas entre apps.** Nada en `apps/api` debe importar de
  `apps/web`, ni al revés. Lo común va a `packages/shared`.
- **Olvidar aprobar un script de instalación nuevo.** Si añades una dependencia
  nativa, `npm install` avisará y la dependencia no funcionará hasta aprobarla
  con `npm approve-scripts <pkg>`.

## Preguntas de repaso

1. ¿Qué gana el proyecto por tener `packages/shared` frente a duplicar tipos?
2. ¿Por qué `shared` se compila dos veces y `ui` ninguna?
3. ¿Qué son los ficheros que escribe `write-module-markers.mjs` y qué pasa si
   los borras?
4. ¿Por qué `@scarf/scarf` no está en `allowScripts`?

## Ejercicios

1. Añade un enum `TestResultStatus` a `packages/shared`, úsalo en la API y en el
   frontend, y comprueba que renombrar un valor rompe la compilación de ambos.
2. Borra `packages/shared/dist` y ejecuta `npm run build -w @qa-flow-hub/api`.
   Explica el error y arréglalo.
3. Mide con `time` cuánto tarda `npm run build` completo y qué paquete domina.

## Qué diría en una entrevista

> "Elegí un monorepo con npm workspaces para que el contrato entre API y
> frontend sea un paquete compartido de esquemas Zod: si el backend cambia un
> campo, el frontend deja de compilar en el mismo commit. Descarté pnpm y
> Turborepo porque con cinco paquetes el coste de aprendizaje no se paga; la
> migración es posible más adelante sin tocar el código de aplicación."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Gestor | npm workspaces | pnpm + Turborepo si los tiempos de CI molestan |
| Orden de build | Explícito en un script | Grafo de tareas con caché |
| `packages/ui` | Fuente sin compilar | Compilado y con Storybook si se abre a terceros |

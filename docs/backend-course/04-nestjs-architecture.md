# 04 — Arquitectura de NestJS

## Concepto

NestJS es un framework de backend que aporta tres cosas: **inyección de
dependencias**, **módulos** y un **ciclo de vida de la petición** con puntos de
extensión bien definidos (guards, interceptors, pipes, filters). No inventa un
servidor HTTP: se apoya en Express o, como aquí, en Fastify.

## Qué problema resuelve

En un Express plano, un proyecto de este tamaño acaba con:

- ficheros que importan servicios directamente, lo que impide sustituirlos en
  las pruebas;
- middleware colocado "donde funciona", con un orden que nadie recuerda;
- lógica de autorización repetida en cada handler.

Nest impone respuestas a esas tres: las dependencias se declaran y se inyectan,
los módulos delimitan qué es público de cada área, y los guards se aplican una
vez de forma global con excepciones explícitas.

**Decisión.** Se descartó Express plano por lo anterior, y se descartó Fastify
plano porque tendríamos que construir la inyección de dependencias y la
modularidad a mano. El coste de Nest es una curva de aprendizaje y algo de
"magia" con decoradores; a cambio, la estructura sobrevive a que el equipo
crezca. Ver [`../adr/0001-use-nestjs.md`](../adr/0001-use-nestjs.md).

## Las piezas

```
Module        agrupa y declara qué expone (controllers, providers, exports)
Controller    traduce HTTP ↔ caso de uso. Sin lógica de negocio.
Provider      cualquier clase inyectable: servicios, repositorios, adaptadores
Guard         decide si la petición continúa (autenticación, roles)
Pipe          transforma y valida la entrada (aquí: Zod)
Interceptor   envuelve la ejecución (auditoría, cabeceras, medición)
Filter        convierte una excepción en respuesta HTTP
```

## Ciclo de vida de una petición

Este es el orden real y conviene memorizarlo, porque explica por qué un guard no
ve el cuerpo ya validado y por qué un filtro ve todo lo que ocurre después:

```
petición
  → middleware (plugins de Fastify: helmet, cors, rate limit)
  → guards            (JwtAuthGuard → ActiveOrgGuard → OrgRolesGuard)
  → interceptors (antes)
  → pipes             (validación Zod del DTO)
  → CONTROLADOR → SERVICIO → REPOSITORIO → PostgreSQL
  → interceptors (después)   (auditoría)
  → filtro de excepciones     (solo si algo lanzó)
respuesta
```

Consecuencia práctica: la **autorización se decide antes de validar el cuerpo**.
Es lo correcto: a alguien que no tiene permiso no se le explica qué campos son
inválidos.

## Archivos reales

- [`apps/api/src/app.module.ts`](../../apps/api/src/app.module.ts) — la raíz de
  composición.
- [`apps/api/src/main.ts`](../../apps/api/src/main.ts) — creación de la
  aplicación y registro de lo global.
- [`apps/api/src/modules/health/`](../../apps/api/src/modules/health/) — el
  módulo más pequeño posible, útil como plantilla.
- [`apps/api/src/common/decorators/public.decorator.ts`](../../apps/api/src/common/decorators/public.decorator.ts)
  — un decorador de metadata propio.

## Código real

La raíz de composición. Todos los módulos se registran aquí y en ningún otro
sitio, para que el grafo se lea de un vistazo:

```ts
// apps/api/src/app.module.ts
@Module({
  imports: [
    AppConfigModule,
    EventEmitterModule.forRoot({ global: true, wildcard: true, verboseMemoryLeak: true }),
    HealthModule,
  ],
})
export class AppModule {}
```

Un módulo mínimo:

```ts
// apps/api/src/modules/health/health.module.ts
@Module({ controllers: [HealthController] })
export class HealthModule {}
```

Un controlador que no hace nada más que traducir HTTP:

```ts
// apps/api/src/modules/health/health.controller.ts
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  @Public()
  @Get()
  live(): { status: 'ok'; uptimeSeconds: number } { /* ... */ }
}
```

`VERSION_NEUTRAL` merece una nota, porque costó un test en rojo: al activar el
versionado por URI, **todas** las rutas reciben el prefijo `/v1`, incluidas las
que están excluidas del prefijo global. Una sonda de salud no es parte de la API
pública versionada y su URL no debe cambiar nunca, así que se declara neutra.

El decorador `@Public()` es metadata, no comportamiento:

```ts
// apps/api/src/common/decorators/public.decorator.ts
export const IS_PUBLIC_KEY = 'qa-flow-hub:isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
```

El guard global lo leerá con `Reflector`. La razón de diseño está en el
comentario del fichero: **el valor por defecto de un endpoint nuevo es
"protegido"**. Abrir una ruta es una decisión explícita y `grep`-eable; el
defecto contrario es cómo se filtran endpoints por accidente.

## Convenciones de este proyecto

- Un módulo por área funcional, dentro de `src/modules/<área>/`.
- Dentro: `*.controller.ts`, `*.service.ts`, `*.repository.ts`, `dto/`,
  `domain/`, `policies/`, `__tests__/`.
- Los controladores **no** contienen `if` de negocio. Si aparece uno, pertenece
  al servicio.
- Los servicios **no** usan Prisma directamente: pasan por el repositorio, que
  es quien garantiza el filtro por organización (capítulos 10 y 16).
- Un módulo que necesita datos de otro **importa el módulo** y usa su servicio
  público. Nunca su repositorio.

## Comandos

```bash
npx nest generate module modules/projects --dry-run   # ver qué crearía
npx nest generate controller modules/projects --dry-run
npm run dev -w @qa-flow-hub/api                       # recarga en caliente
```

## Errores comunes

- **`Nest can't resolve dependencies of the X (?)`.** El `?` indica la posición
  del argumento que no sabe resolver. Causas: el proveedor no está en
  `providers`, el módulo que lo define no lo `exports`, o hay un `import type`.
- **Dependencia circular entre módulos.** Se manifiesta como un proveedor
  `undefined`. La solución correcta no suele ser `forwardRef`, sino mover lo
  compartido a un tercer módulo.
- **Poner lógica en el controlador.** Compila, funciona, y hace que esa regla no
  sea reutilizable ni comprobable sin HTTP.
- **Registrar un guard global sin escapes.** Sin `@Public()`, el propio login
  requeriría estar autenticado.

## Preguntas de repaso

1. ¿En qué orden se ejecutan guard, pipe y filtro, y qué implica que la
   autorización vaya antes que la validación?
2. ¿Por qué el controlador de salud es `VERSION_NEUTRAL`?
3. ¿Qué hace exactamente `@Public()` por sí solo? (Pista: casi nada.)
4. ¿Por qué un módulo no debe importar el repositorio de otro?

## Ejercicios

1. Genera un módulo `ping` con el CLI, exponlo en `/api/v1/ping` y escribe un
   test de integración. Compara la URL con la de `/health` y explica la
   diferencia.
2. Crea un interceptor que añada la cabecera `X-Response-Time` y regístralo
   globalmente. Comprueba con `curl -i`.
3. Provoca a propósito un error de dependencias quitando un `exports` y aprende
   a leer el mensaje.

## Qué diría en una entrevista

> "Uso NestJS como monolito modular: cada área funcional es un módulo con su
> controlador, su servicio y su repositorio, y el `AppModule` es la única raíz
> de composición. Lo que más valor me da no son los decoradores, sino que la
> inyección de dependencias hace que los servicios sean comprobables sin HTTP y
> que las políticas transversales —autenticación, auditoría, errores— se
> declaren una vez de forma global en lugar de repetirse por endpoint."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Módulos | Un despliegue, un proceso | Extraer un módulo a servicio si un límite lo justifica |
| Eventos | `EventEmitter2` en proceso | Cola externa con reintentos y persistencia |
| Versionado | `v1` por URI | `v2` conviviendo, con desuso anunciado |

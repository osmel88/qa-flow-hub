# 00 — Cómo usar este curso

## Qué es esto

No es un tutorial genérico de Node.js. Es una explicación del backend **de este
repositorio**, capítulo a capítulo, escrita mientras el código se construía.
Cada capítulo apunta a archivos reales, con rutas reales, y los fragmentos que
verás están copiados del código que ejecuta la aplicación. Si un fragmento y el
archivo no coinciden, el capítulo tiene un error: es un bug de documentación y
debe corregirse igual que un bug de código.

El objetivo no es que sepas *usar* qa-flow-hub, sino que puedas **tomar
decisiones de desarrollo sobre él**: añadir un módulo, cambiar una regla de
autorización, diagnosticar por qué una consulta devuelve datos de otra
organización, o defender en una entrevista por qué el proyecto está construido
así.

## Cómo está organizado

| Bloque | Capítulos | Qué cubre |
| --- | --- | --- |
| Fundamentos | 01–07 | Producto, runtime, TypeScript, NestJS, Fastify, monorepo, configuración |
| Datos | 08–11 | PostgreSQL, Prisma, multi-tenancy, modelo de dominio |
| Seguridad | 12–13, 30 | Autenticación, autorización, seguridad de la API |
| Capas | 14–20 | Controladores, servicios, repositorios, transacciones, validación, errores, auditoría |
| Módulos | 21–27 | Cada módulo funcional y los adaptadores de integración |
| Calidad | 28–29, 33–35 | Pruebas, depuración, rendimiento, refactorización |
| Operación | 31–32 | Docker y CI/CD |
| Cierre | 36–39 | Entrevistas, ejercicios, plan de estudio, hoja de ruta comercial |

Los capítulos se pueden leer en orden o por bloques. Si vienes de frontend y
quieres el camino más corto a "entiendo cómo funciona esto", lee 01, 04, 11, 12,
16 y 26.

## Cómo está escrito cada capítulo

Todos siguen la misma estructura, y no por burocracia: cada sección responde a
una pregunta distinta que te vas a hacer en momentos distintos.

1. **Concepto** — qué es.
2. **Qué problema resuelve** — por qué existe. Si no hay problema, no hay
   herramienta: esta sección es la que te permite decidir cuándo *no* usarla.
3. **Archivos reales** — dónde vive en este repositorio.
4. **Flujo por capas** — cómo participa en el recorrido de una petición.
5. **Código real** — fragmentos pequeños, comentados.
6. **Comandos** — qué escribir en la terminal para verlo funcionar.
7. **Errores comunes** — los que vas a cometer, con el mensaje de error literal
   cuando es posible.
8. **Preguntas de repaso** — para responder sin mirar.
9. **Ejercicios** — para modificar el código de verdad.
10. **Qué diría en una entrevista** — la versión de dos minutos, en voz alta.
11. **MVP vs futuro** — qué está así porque es lo correcto y qué está así porque
    es lo suficientemente bueno *por ahora*. Esta distinción es la más
    importante del curso.

## Cómo estudiarlo

Leer no sirve. El plan mínimo por capítulo es:

1. Lee el capítulo entero una vez, sin tocar nada.
2. Abre los archivos que menciona y léelos en el editor, no en el documento.
3. Ejecuta los comandos.
4. **Rompe algo a propósito**: borra una línea, cambia un tipo, quita un guard.
   Observa el error. Deshaz.
5. Haz los ejercicios.
6. Responde las preguntas de repaso en voz alta.

El paso 4 es el que produce conocimiento real. Un backend se entiende por sus
fallos, no por sus aciertos.

Si tienes 30 días, sigue [`38-study-plan-30-days.md`](38-study-plan-30-days.md).

## Requisitos previos

- Node.js 24 (`nvm use` en la raíz del repositorio lee `.nvmrc`).
- Docker y Docker Compose.
- Saber JavaScript moderno: `async/await`, promesas, destructuring, módulos.
- TypeScript básico. El capítulo 03 cubre lo que este backend usa de verdad, no
  el lenguaje entero.
- No necesitas saber SQL avanzado. El capítulo 08 cubre lo necesario.

## Puesta en marcha

```bash
nvm use                        # Node 24
cp .env.example .env           # y cambia los dos secretos JWT
npm install
docker compose up -d postgres postgres-test
npm run db:migrate
npm run db:seed
npm run dev
```

Con eso tienes la API en `http://localhost:3000/api/v1`, la documentación
OpenAPI en `http://localhost:3000/docs` y el cliente web en
`http://localhost:5173`.

## Convenciones de este curso

- Los comentarios del código están en inglés; el curso está en español. Es una
  decisión deliberada: el código es un artefacto de un producto que puede tener
  colaboradores internacionales, y el curso es material de estudio personal.
- Cuando digo "el servicio", me refiero a la clase `*.service.ts` del módulo
  correspondiente, no a un microservicio. Este backend es un **monolito
  modular**; no hay servicios de red internos.
- Los bloques marcados con **Decisión** explican una alternativa descartada.
  Aprender por qué *no* se hizo algo es la mitad del aprendizaje de arquitectura.

## Qué diría en una entrevista

> "Documenté el backend como un curso porque escribir la explicación es la
> prueba más barata de que entiendes el diseño. Cuando un capítulo se hacía
> difícil de escribir, casi siempre era porque el código tenía una
> responsabilidad mal repartida, y acababa refactorizando antes de documentar."

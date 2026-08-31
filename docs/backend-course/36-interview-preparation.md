# 36 — Preparación de entrevistas

## Concepto

Este capítulo no es una lista de preguntas de trivial sobre Node.js. Es el guion
para usar **este proyecto** como respuesta a las preguntas que de verdad se hacen
en una entrevista de backend: *cuéntame algo que hayas construido*, *qué decisión
técnica defenderías*, *qué harías distinto*.

La regla que gobierna todo el capítulo: **una decisión con su alternativa
descartada vale más que diez tecnologías nombradas**. Decir "usé Prisma" no dice
nada; decir "usé Prisma y acepté perder algo de control en las consultas complejas
a cambio de tipos generados desde una única fuente de verdad, y por eso la matriz
de trazabilidad está escrita con `groupBy` y no con SQL crudo" es una respuesta de
ingeniero.

## El resumen de dos minutos

Práctica: dilo en voz alta, con reloj.

> "qa-flow-hub es un gestor de pruebas multi-tenant: organizaciones, proyectos,
> requisitos, casos de prueba, ejecuciones, defectos y la trazabilidad que une
> todo. Backend en NestJS sobre Fastify con PostgreSQL y Prisma, frontend en React,
> monorepo con contratos Zod compartidos entre los dos.
>
> El riesgo dominante del producto no es un cálculo: es que la organización A lea
> una fila de la B. Está resuelto en cuatro capas —token, guard, repositorio y Row
> Level Security con un rol que no es propietario de las tablas— y probado con una
> suite que hace el ataque realista: conozco el id exacto del recurso ajeno y exijo
> un 404.
>
> Lo que más me enseñó fue la parte que no es código: cada decisión discutible está
> anotada con su coste y su disparador de revisión, así que el proyecto puede decir
> qué está bien hecho y qué está *suficientemente* bien hecho por ahora."

## Las diez preguntas que este proyecto responde bien

Cada una con el capítulo donde está la respuesta larga.

| Pregunta | Respuesta corta | Capítulo |
| --- | --- | --- |
| ¿Cómo aíslas los datos de cada cliente? | `organizationId` en toda tabla, `AsyncLocalStorage`, clase base de repositorio, RLS con rol no propietario | 10 |
| ¿Por qué no un esquema por cliente? | Migrar N esquemas es la operación que rompe; un `where` indexado no | 10, ADR 0006 |
| ¿Dónde vive la autorización? | Rol en guards, reglas sobre objetos en servicios, donde el objeto está cargado | 13 |
| ¿Por qué el rol no va en el token? | Un token no se puede desemitir; revocar una membresía debe ser inmediato | 12 |
| ¿Cómo evitas robo de sesión por XSS? | Refresh en cookie `HttpOnly`, `SameSite=Strict`, rotación con revocación de familia | 30 |
| ¿Cómo validas la entrada? | Zod compartido, el pipe **sustituye** el valor; claves desconocidas se descartan | 18, 30 |
| ¿Qué haces cuando una integración externa no está configurada? | El adaptador falla con un error explícito; no finge un `JIRA-123` | 27 |
| ¿Cómo garantizas que un informe no miente? | Cobertura ≠ verificación; un caso archivado no cuenta; un defecto abierto rompe "verificado" | 26 |
| ¿Cómo evitas N+1 en el dashboard? | 9 agregados en paralelo, `count`/`groupBy`, nunca por elemento | 34 |
| ¿Qué probarías si solo pudieras escribir diez tests? | Los diez de aislamiento entre organizaciones | 29 |

## Cómo contar una decisión (plantilla de cuatro frases)

1. **El problema, en términos del producto.** "Un enlace de trazabilidad podía
   quedar apuntando a un caso borrado."
2. **La alternativa que descarté y por qué.** "Podía añadir `deletedAt` al enlace,
   pero su valor depende de una función de restauración que no existe: una columna
   que nadie restaura es deuda disfrazada de prudencia."
3. **La decisión y su coste.** "Purgo el enlace en la misma transacción del borrado
   lógico; el historial queda en el log de auditoría, y el coste es que no se puede
   deshacer."
4. **Cómo lo sé.** "Diez tests de integración: los cinco extremos, la purga en
   ambos sentidos, y que los enlaces de otro proyecto quedan intactos."

La cuarta frase es la que separa a un candidato de otro. Casi nadie la dice.

## Los errores que este proyecto encontró (y por qué contarlos es bueno)

Contar un fallo propio, con su causa y su prueba, es la señal más fuerte de
seniority que se puede dar en 30 segundos. Tres reales:

- **`/health` respondía en los tests y `404` en producción**, porque el versionado
  por URI también prefija las rutas excluidas del prefijo global. Lección: la app
  de test debe ser la app, no una parecida.
- **`invitations.service` no comprobaba rango**, así que un admin podría haber
  invitado a un owner y quedar por debajo de su propio invitado. No era explotable
  porque el contrato Zod no lo aceptaba, pero la regla vivía en un solo sitio y era
  el equivocado.
- **Un test aseguraba `String(cuerpo)`**, que da `"[object Object]"`: pasaba con
  cualquier contenido. Lo encontró el linter con tipos, no una persona.

## Preguntas que te van a hacer y que este proyecto **no** responde

Prepararlas es tan importante como las anteriores; la respuesta honesta es "no
está, y sé qué implicaría":

- **Escalado horizontal real.** El límite de peticiones es por instancia y no hay
  caché compartida: hace falta Redis.
- **Colas y trabajo asíncrono.** No hay job runner, así que no hay reintentos ni
  retención programada de auditoría.
- **Observabilidad.** Logs estructurados sí; métricas, trazas y alertas no.
- **Multi-región y RPO/RTO.** No hay plan de recuperación más allá de copias.
- **SSO/SAML y MFA.** Requisito de compra empresarial, no implementado.
- **Migraciones sin tiempo de caída** en tablas grandes (columna nueva no nula,
  reescritura de tabla). Sé el patrón —añadir nullable, rellenar por lotes,
  imponer restricción— pero no está ejercitado aquí.

## Ejercicio de simulación

Grábate respondiendo, en este orden, con dos minutos por respuesta:

1. Cuéntame el proyecto.
2. ¿Cuál es la decisión de la que estás más orgulloso?
3. ¿Cuál cambiarías hoy?
4. Un cliente dice que ve datos de otro cliente. ¿Qué haces en los primeros diez
   minutos?
5. Te pido añadir "archivar un proyecto con todo su contenido". ¿Cómo lo diseñas y
   qué preguntas antes de escribir código?

Escucha la grabación buscando dos cosas: cuántas veces dices "es lo estándar" (una
respuesta vacía) y cuántas veces dices "el coste de eso es…" (una respuesta de
ingeniero).

## Qué diría en una entrevista

> "Uso este proyecto en las entrevistas porque puedo enseñar el razonamiento, no
> solo el resultado: hay un fichero de deuda técnica con veinticuatro entradas, cada
> una con su coste y el disparador que la haría urgente. Cuando alguien me pregunta
> qué haría distinto, no improviso: la lista existía antes de la pregunta."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Narrativa | Cuatro capas de aislamiento y decisiones anotadas | Casos de rendimiento con datos de producción real |
| Puntos débiles | Enumerados y con disparador | Cerrados uno a uno, empezando por Redis y observabilidad |
| Práctica | Guion escrito y grabación propia | Entrevistas simuladas con otra persona |

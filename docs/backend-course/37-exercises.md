# 37 — Ejercicios progresivos

## Concepto

Los capítulos anteriores tienen ejercicios pequeños. Este tiene **cinco proyectos
completos** sobre el código real, ordenados por dificultad, cada uno con criterios
de aceptación verificables. La diferencia importa: un ejercicio de capítulo
comprueba que entendiste una pieza; estos comprueban que puedes atravesar el
sistema entero —contrato, migración, repositorio, servicio, controlador, tests,
frontend y documentación— que es lo que de verdad significa "asumir decisiones de
desarrollo".

Regla para todos: **si no hay test, no está hecho**. Y si un test que ya existía
falla, la hipótesis por defecto es que tu cambio tiene el bug.

## Cómo trabajar cada ejercicio

```bash
git checkout -b ejercicio/<nombre>
# ... trabajo ...
npm run lint && npm run typecheck && npm run test && npm run test:integration && npm run build
```

Y antes de escribir código, responde por escrito tres preguntas:

1. ¿Qué tabla o campo nuevo necesito, y lleva `organizationId`?
2. ¿Qué contrato de `packages/shared` cambia, y rompe al cliente?
3. ¿Qué test escribo **primero** para que falle por la razón correcta?

## Ejercicio 1 — Etiquetas como entidad, no como array (nivel: recorrido completo)

**Punto de partida real:** hoy `TestCase.tags` es un `String[]` y `GET
/test-cases?tag=smoke` filtra con `tags: { has: tag }`. Es simple y suficiente para
filtrar, y es incapaz de dos cosas que un cliente pide en cuanto tiene 500 casos:
**listar** las etiquetas que existen en el proyecto y **renombrar** una en todas
partes.

**Objetivo:** convertir las etiquetas en una entidad del proyecto, con
`GET /projects/:id/tags` y renombrado, sin perder los datos actuales.

**Recorrido:** migración con backfill, esquema Prisma, contrato Zod, repositorio,
servicio, controlador, cliente web y capítulo 23 actualizado.

**Criterios de aceptación:**

- la migración **conserva** las etiquetas existentes: escribe el backfill en SQL y
  pruébalo con datos sembrados, no con una tabla vacía;
- la tabla nueva lleva `organizationId` y un índice que empieza por él;
- `GET /test-cases?tag=smoke` sigue funcionando igual desde fuera: el contrato del
  filtro no cambia;
- una etiqueta de otra organización devuelve lista vacía, no error;
- renombrar queda auditado y es una sola operación, no N escrituras por caso;
- al menos tres tests de integración, uno de ellos de aislamiento entre
  organizaciones.

**La decisión que debes escribir:** ¿mantienes el array como caché desnormalizada
para no romper el filtro, o migras el filtro a un `join`? Las dos son defendibles;
una duplica el estado y la otra cambia el plan de todas las consultas de lista.

## Ejercicio 2 — Comentarios en defectos (nivel: reglas sobre objetos)

**Objetivo:** cualquier miembro puede comentar un defecto; solo el autor puede
editar su comentario en los primeros 15 minutos; nadie puede borrarlos.

**Por qué este:** obliga a poner una regla **sobre el objeto** —"solo el autor"— en
el sitio correcto (el servicio, no el guard) y a razonar sobre el tiempo, que es la
fuente clásica de tests intermitentes.

**Criterios de aceptación:**

- `403` documentado al editar el comentario de otro;
- el límite de 15 minutos se prueba **sin dormir el test**: inyecta el reloj o
  escribe la fila con un `createdAt` antiguo;
- un comentario de un defecto de otra organización responde `404`;
- el defecto no cambia de estado por recibir un comentario.

## Ejercicio 3 — Exportar la matriz de trazabilidad a CSV (nivel: contrato y formato)

**Objetivo:** `GET /traceability/matrix.csv` devuelve la misma información que el
endpoint JSON, con `Content-Type: text/csv` y un nombre de fichero sugerido.

**Por qué este:** es la petición número uno de un cliente real de QA, y fuerza
decisiones que no son de código: qué columnas, cómo se representa un caso
archivado, qué pasa con las comas dentro de un título.

**Criterios de aceptación:**

- una sola fuente de verdad: el CSV **no** recalcula la cobertura, la formatea;
- un título con comas y comillas se escapa correctamente, con un test que lo
  demuestre;
- los casos archivados aparecen marcados y no cuentan como cobertura, igual que en
  el JSON;
- la respuesta respeta el aislamiento por organización;
- documentado en `docs/api-conventions.md`, porque es el primer endpoint que no
  devuelve JSON.

## Ejercicio 4 — Cerrar la deuda 22: el rol de proyecto restringe la lectura (nivel: diseño)

**Objetivo:** hoy un rol por proyecto puede cambiar lo que puedes **hacer**, pero
todo miembro sigue **viendo** todos los proyectos de la organización. Que un
miembro con membresías explícitas de proyecto solo vea esos.

**Por qué este:** es el ejercicio más difícil del capítulo y el más parecido al
trabajo real, porque la parte dura no es el filtro: es decidir qué significa
"visible" y no romper 226 tests que asumen lo contrario.

**Preguntas que debes responder antes de tocar código:**

- ¿Un admin de la organización ve todos los proyectos aunque no sea miembro de
  ninguno? (Respuesta esperada: sí, y hay que escribirlo.)
- ¿"Sin membresías explícitas" significa "ve todo" o "no ve nada"? Ambas son
  defendibles; una es peor de explicar a un cliente.
- ¿El filtro va en el repositorio de proyectos o en cada entidad hija?
- ¿Y el dashboard? Un agregado que cuenta proyectos invisibles es una fuga por el
  lado del informe.

**Criterios de aceptación:** el cambio no relaja ningún test de aislamiento
existente, la matriz de permisos queda actualizada y la entrada 22 de
`technical-debt.md` se marca como resuelta con lo que **no** cubre.

## Ejercicio 5 — Adaptador real de Jira (nivel: integración externa)

**Objetivo:** sustituir el proveedor *noop* de defectos por uno que cree de verdad
una incidencia en Jira Cloud.

**Por qué este:** el capítulo 27 dejó los puertos definidos precisamente para esto.
Es el ejercicio que enseña que una integración es 20 % API y 80 % fallos:
credenciales caducadas, límites de tasa, campos obligatorios del proyecto destino,
un `POST` que triunfó y una respuesta que se perdió.

**Criterios de aceptación:**

- el secreto se resuelve por `secretRef`; **ningún token de cliente entra en la
  base de datos**;
- los fallos de red y `429` se distinguen de los de datos (`400`), con un error de
  dominio para cada uno;
- si Jira crea la incidencia y la respuesta se pierde, no se crea dos veces:
  diseña la idempotencia y documéntala;
- los tests usan un doble del cliente HTTP, no la Jira real, y hay un test de
  contrato que registra la forma de respuesta que asumes;
- sin credenciales configuradas, el comportamiento actual no cambia (falla
  explícito, nunca inventa una clave).

## Cómo saber si un ejercicio está bien hecho

Cinco preguntas, y las cinco tienen que ser "sí":

1. ¿Un desconocido entiende **por qué** decidiste así leyendo solo el commit y los
   comentarios?
2. ¿Existe un test que falla si alguien deshace tu cambio?
3. ¿Hay un test de aislamiento entre organizaciones para cada tabla nueva?
4. ¿La documentación afectada quedó actualizada en el mismo commit?
5. ¿Lo que **no** hiciste está anotado en `technical-debt.md` con su disparador?

## Qué diría en una entrevista

> "La forma en la que estudié el proyecto fue implementar funciones nuevas de punta
> a punta sobre él: etiquetas, comentarios con una regla de autoría, exportación de
> la matriz. El ejercicio que más me enseñó fue restringir la visibilidad por
> proyecto, porque el filtro era una tarde y decidir qué significa 'visible' para un
> admin sin membresías fue el trabajo de verdad."

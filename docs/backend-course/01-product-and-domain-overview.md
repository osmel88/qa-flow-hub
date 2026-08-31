# 01 — El producto y su dominio

## Concepto

qa-flow-hub es una plataforma de gestión de QA. Su trabajo es mantener intacta
una cadena de información que en la mayoría de los equipos vive rota, repartida
entre una hoja de cálculo, un Jira y la memoria de una persona:

```
Requisito → Caso de prueba → Ejecución → Resultado → Defecto
```

Cuando esa cadena está completa y es consultable, un equipo puede responder tres
preguntas que deciden si se publica una versión:

1. ¿Qué requisitos **no** tienen ningún caso de prueba? (cobertura)
2. De lo que se ejecutó en esta release, ¿qué falló y qué defecto lo documenta?
3. Si este defecto se reabre, ¿qué requisito está en riesgo?

Sin trazabilidad, las tres se responden "creo que sí".

## Qué problema resuelve

El problema no es "no tenemos dónde escribir los casos de prueba". Confluence
sirve para eso. El problema es que la información de QA es **relacional y
temporal**:

- relacional, porque el valor está en los enlaces, no en los nodos;
- temporal, porque un caso de prueba cambia y una ejecución pasada debe seguir
  significando lo que significaba cuando se ejecutó.

Ese segundo punto es el que rompe las soluciones caseras. Si editas el caso
"Login con contraseña caducada" y una ejecución de hace tres meses apunta al
caso *actual*, el informe histórico miente. Por eso en este sistema, cuando un
caso entra en una ejecución, se guarda una **instantánea** del caso
(`TestRunCase.caseSnapshot`); el capítulo 24 lo desarrolla.

## Vocabulario del dominio

Merece la pena fijarlo ahora, porque los nombres de las tablas, de los módulos y
de las rutas HTTP son estos y no otros.

| Término | Qué es | Ejemplo |
| --- | --- | --- |
| **Organization** | El inquilino (*tenant*). Todo dato funcional pertenece a uno. | "Acme QA" |
| **OrganizationMember** | Un usuario dentro de una organización, con un rol. | Ana como `qa-lead` en Acme |
| **Project** | Unidad de trabajo dentro de una organización. | "Portal web" |
| **Requirement** | Lo que se pide: historia, requisito, épica o requisito no funcional. | "WEB-R-14: recuperar contraseña" |
| **TestSuite** | Contenedor de casos de un proyecto. | "Regresión web" |
| **TestSection** | Carpeta jerárquica dentro de una suite. | "Autenticación / Recuperación" |
| **TestCase** | Qué se va a verificar, con precondiciones y resultado esperado. | "WEB-C-102: enlace caducado" |
| **TestStep** | Paso ordenado dentro de un caso. | "1. Abrir el enlace" |
| **TestRun** | Una campaña de ejecución: qué casos, quién y cuándo. | "Release 2.4 — smoke" |
| **TestRunCase** | Un caso concreto dentro de una ejecución, con su instantánea. | WEB-C-102 en "Release 2.4" |
| **TestResult** | El resultado de ejecutar ese caso una vez. | `failed`, con comentario |
| **Defect** | Un fallo documentado, normalmente nacido de un resultado `failed`. | "WEB-D-7: enlace caduca en 1 min" |
| **TraceabilityLink** | Un enlace explícito entre dos entidades. | Requisito ↔ caso |
| **AuditLog** | Quién hizo qué, cuándo y sobre qué. | "ana cambió el rol de luis" |

Dos precisiones que evitan confusiones más adelante:

- **`TestCase` no es `TestRunCase`.** El primero es la definición; el segundo es
  la instancia dentro de una ejecución concreta. Un mismo caso puede estar en
  cincuenta ejecuciones.
- **`TestResult` es un histórico, no un estado.** Cada intento crea una fila.
  El estado "actual" de un caso en una ejecución vive en
  `TestRunCase.latestStatus`, que es una proyección del último resultado.

## Los cinco estados de un resultado

```
passed    la verificación se realizó y el comportamiento fue el esperado
failed    la verificación se realizó y el comportamiento no fue el esperado
blocked   no se pudo verificar por una causa externa (entorno caído, dato inexistente)
skipped   se decidió no verificar en esta ejecución
untested  todavía no se ha intentado
```

La diferencia entre `blocked` y `skipped` no es cosmética: `blocked` es una
señal de que el entorno o una dependencia está impidiendo trabajar, y en el
dashboard debe destacar. `skipped` es una decisión del equipo. Mezclarlos, como
hacen muchas hojas de cálculo, oculta problemas de entorno.

## Multi-tenancy en una frase

Todo dato funcional pertenece a una organización; un usuario puede pertenecer a
varias con **roles distintos en cada una**; y ninguna consulta puede devolver
datos de una organización a la que el usuario no pertenece. Esa última frase es
el requisito de seguridad número uno del producto y el capítulo 10 está dedicado
entero a cómo se garantiza.

## Roles

Seis, deliberadamente pocos para el MVP:

`organization-owner`, `organization-admin`, `project-manager`, `qa-lead`,
`tester`, `viewer`.

La matriz completa está en [`../permissions-matrix.md`](../permissions-matrix.md).
La idea rectora: **el tester ejecuta y reporta; no diseña el plan de pruebas ni
administra la organización**.

## Qué NO es este producto (todavía)

- No es un gestor de incidencias que sustituya a Jira. Crea defectos, pero el
  camino previsto es sincronizarlos con el rastreador del cliente.
- No es una herramienta de automatización. Se **enlaza** con pruebas
  automatizadas mediante `ExternalReference`, pero no ejecuta nada.
- No implementa pagos, envío de correos ni almacenamiento real de adjuntos.

Estas ausencias son decisiones de alcance, no olvidos. Están en
[`../technical-debt.md`](../technical-debt.md) con su justificación.

## Archivos reales

En esta fase el dominio todavía no tiene código: se materializa en el esquema de
Prisma y en los módulos. Lo que ya puedes leer:

- [`docs/product-vision.md`](../product-vision.md) — el ángulo de producto.
- [`docs/domain-model.md`](../domain-model.md) — entidades y relaciones.
- [`apps/api/prisma/schema.prisma`](../../apps/api/prisma/schema.prisma) — la
  traducción del dominio a tablas.

## Errores comunes

- **Modelar el resultado como un campo del caso.** Tentador y fatal: pierdes el
  histórico y no puedes ejecutar el mismo caso en dos releases.
- **Convertir la trazabilidad en seis tablas de unión.** Aquí es una sola tabla
  polimórfica (`TraceabilityLink`), porque los tipos de enlace crecerán y no
  quieres una migración por cada uno.
- **Confundir "proyecto" con "organización".** Un cliente es una organización;
  sus productos son proyectos. Si los mezclas, el aislamiento multi-tenant se
  vuelve imposible de razonar.

## Preguntas de repaso

1. ¿Por qué `TestRunCase` guarda una instantánea del caso en lugar de apuntar
   solo a su `id`?
2. ¿Qué diferencia práctica hay entre `blocked` y `skipped` para un jefe de QA?
3. Un usuario es `qa-lead` en la organización A y `viewer` en la B. ¿Dónde vive
   esa información?
4. ¿Por qué `TestResult` no se actualiza nunca, solo se inserta?

## Ejercicios

1. Escribe, sin mirar el esquema, las ocho entidades que hacen falta para
   responder "¿qué requisitos de este proyecto no tienen ningún caso?".
2. Diseña en papel la consulta de esa matriz de cobertura. ¿Qué índices
   necesitarías?
3. Enumera tres preguntas de negocio que este modelo **no** puede responder hoy
   y qué entidad habría que añadir para cada una.

## Qué diría en una entrevista

> "El dominio de QA parece un CRUD hasta que aparecen dos requisitos: la
> trazabilidad extremo a extremo y la inmutabilidad del histórico. Modelamos los
> resultados como eventos append-only y guardamos una instantánea del caso al
> incluirlo en una ejecución, para que editar un caso no reescriba la historia.
> Eso es lo que permite que un informe de release siga siendo cierto seis meses
> después."

## MVP vs futuro

| Área | MVP | Futuro |
| --- | --- | --- |
| Defectos | Entidad propia dentro del producto | Sincronización bidireccional con Jira |
| Automatización | Enlace por `ExternalReference` | Ingesta de resultados de CI |
| Adjuntos | Solo metadatos | Subida real con URLs prefirmadas |
| Roles | Seis roles fijos | Permisos granulares por proyecto |

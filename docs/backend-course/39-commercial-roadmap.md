# 39 — Del proyecto al producto

## Concepto

Este es el último capítulo y no es técnico: es el que convierte "tengo un
repositorio que funciona" en "sé qué falta para que alguien pague por esto, en qué
orden y por qué". La secuencia completa vive en
[`../commercial-roadmap.md`](../commercial-roadmap.md); aquí está el razonamiento,
que es lo que se estudia.

La idea central: **priorizar no es ordenar por dificultad ni por interés técnico**.
Es responder qué impide hoy que un equipo real use el producto una semana entera.

## Qué problema resuelve

El fallo típico de un proyecto personal bien construido es seguir construyendo lo
que resulta interesante. Aquí eso sería añadir un sexto módulo, cuando lo que
bloquea a un cliente es que **nadie recibe el correo de invitación** y que **un
tester no puede adjuntar la captura del fallo**.

Dos reglas ordenan el mapa:

1. **Nada antes de lo que bloquea una prueba de producto.** Una función a la que
   nadie llega vale cero, por buena que sea.
2. **Nada que ponga en riesgo el aislamiento.** Una fuga entre clientes termina con
   el producto. Cualquier paso que toque tenancy paga primero sus propios tests.

## Los tres bloqueos reales de hoy

Todo lo demás es mejora; esto es lo que impide una prueba honesta con un equipo:

| Bloqueo | Estado real | Por qué bloquea |
| --- | --- | --- |
| **Correo** | Las invitaciones existen, se auditan y el token se devuelve en la respuesta de la API | No se puede incorporar a un equipo, y ese token en la respuesta **no puede llegar a producción** |
| **Adjuntos** | Solo metadatos: no se almacena ningún fichero | Un tester no puede adjuntar la captura del fallo; es la carencia más visible frente a TestRail y Xray |
| **Importación** | No existe | Nadie reescribe 2000 casos a mano: importar es la diferencia entre una prueba y una migración |

Los tres son de esfuerzo pequeño o medio. Ninguno es interesante técnicamente. Ese
contraste es exactamente la lección del capítulo.

## Cómo se decide el orden (con el ejemplo de Jira)

Integrar Jira de verdad es lo más valioso de la etapa 1, porque casi ningún equipo
adopta un segundo gestor de defectos: el argumento de venta es "tus defectos siguen
en Jira, la trazabilidad vive aquí". Y aun así va **después** del correo y los
adjuntos, porque un cliente que no puede invitar a su equipo no llega nunca a
configurar Jira.

Lo que ya está preparado —y por eso es una implementación, no una migración— es la
forma: `IntegrationConnection` con `credentialRef` en vez del secreto,
`ExternalReference` polimórfica, y los puertos del capítulo 27. Lo que falta es el
80 % que no es la API: credenciales caducadas, `429`, campos obligatorios del
proyecto destino, y un `POST` que triunfó cuya respuesta se perdió.

## La deuda técnica, leída como negocio

`technical-debt.md` no es una lista de deseos. Sus 24 entradas caen en tres cubos, y
esa clasificación es lo que hace útil el fichero:

- **Bloquea una venta:** correo (4, 10), adjuntos (2), visibilidad por proyecto (22),
  claves de API para clientes máquina (20).
- **Bloquea escala, invisible hasta que muerde:** límite de peticiones compartido
  (1), job runner (3), agregación del dashboard (16), paginación de la matriz
  (14, 17).
- **Deliberada y quizá permanente:** adaptadores *noop* hasta que un cliente nombre
  su herramienta (18), una sola versión de OpenAPI (13), caducidad de invitaciones
  resuelta de forma perezosa (12).

Cuando alguien pide algo, la respuesta no es una estimación improvisada: es una
entrada que ya tiene coste y disparador escritos. Eso es lo que se gana anotando
deuda en el momento de contraerla y no al final.

## Lo que este producto no va a hacer

Decidir qué **no** se construye es parte del diseño:

- **Sustituir a Jira.** Si el módulo de defectos deriva hacia competir con gestores
  de incidencias, pierdes en funciones y en foco. Los defectos existen aquí para
  cerrar la cadena de trazabilidad.
- **Ejecutar pruebas.** Esto no es un runner. Las automatizadas se enlazan y sus
  resultados se ingieren; la ejecución se queda donde ya funciona.
- **Microservicios.** Un monolito modular con un PostgreSQL es la forma correcta para
  esta carga y este tamaño de equipo (ADR 0007). Partirlo es responder a un problema
  de escala que no existe.

## Preguntas de repaso

1. ¿Por qué el correo va antes que la integración con Jira, si Jira vale más?
2. ¿Qué significa que `Organization.plan` ya exista para el trabajo de facturación?
3. ¿Por qué la visibilidad por proyecto es el elemento más caro de la etapa 2 aunque
   el filtro sea sencillo?
4. Nombra dos deudas técnicas que un cliente notaría y dos que no.
5. ¿Por qué "no ejecutar pruebas" es una decisión de producto y no una carencia?

## Ejercicios

1. Escribe la especificación de la integración de correo: qué eventos, qué
   plantillas, qué pasa si el proveedor falla y por qué eso necesita el job runner.
2. Estima los adjuntos de verdad: almacenamiento, subida firmada, límites, antivirus
   y qué ocurre al borrar un resultado que tiene ficheros.
3. Coge una entrada de deuda del cubo "bloquea una venta" y ciérrala completa: código,
   tests, documentación y la entrada marcada como resuelta con lo que **no** cubre.
4. Escribe el guion de una demo de diez minutos que no toque ninguna de las tres
   carencias bloqueantes. Fíjate en cuánto tienes que esquivar: eso mide el bloqueo.

## Qué diría en una entrevista

> "El producto está completo en lo difícil —tenancy, autorización, trazabilidad,
> auditoría inmutable— y le faltan tres cosas fáciles que son las que bloquean una
> venta: enviar correos, adjuntar ficheros e importar datos. Ordeno por lo que
> bloquea una prueba real, no por lo que me apetece programar, y la integración con
> Jira, que es lo más valioso, va después, porque un cliente que no puede invitar a
> su equipo nunca llega a configurarla.
>
> Y tengo la lista escrita desde antes de que me la pidan: veintitrés entradas de
> deuda técnica clasificadas en 'bloquea una venta', 'bloquea escala' y
> 'deliberada', cada una con su disparador. Documentar la deuda mientras la contraes
> es lo que convierte una discusión de opiniones en una decisión con coste."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Onboarding | Invitación con token en la respuesta | Correo real, recuperación de contraseña, SSO |
| Evidencias | Metadatos de adjuntos | Almacenamiento con subida firmada y límites |
| Migración de datos | Ninguna | Importación CSV/TestRail con simulación previa |
| Integraciones | Contratos con proveedores *noop* | Jira real, ingestión desde CI, notificaciones |
| Monetización | `Organization.plan` sin lógica | Facturación, límites por plan, facturas |
| Empresa | Roles por organización y por proyecto | SSO/SAML, SCIM, campos personalizados, despliegue dedicado |

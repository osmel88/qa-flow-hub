# 38 — Plan de estudio de 30 días

## Concepto

Un plan para pasar de "leí el código" a "puedo decidir sobre el código" en 30
sesiones de entre 60 y 90 minutos. Está ordenado por **dependencias reales**, no
por número de capítulo: la autorización no se entiende sin el modelo de tenancy, y
el modelo de tenancy no se entiende sin haber visto un `where` de Prisma.

Cada día tiene tres partes, y la tercera es la que produce conocimiento:

1. **Leer** el capítulo.
2. **Abrir** los archivos en el editor y seguir el flujo de una petición.
3. **Romper algo a propósito**, observar el error exacto y deshacer.

Si un día se alarga, corta la lectura, nunca el paso 3.

## Semana 1 — Fundamentos y datos

| Día | Capítulos | Rompe a propósito |
| --- | --- | --- |
| 1 | 00, 01 | Levanta el entorno completo y rompe una variable de entorno: la app debe negarse a arrancar |
| 2 | 02, 07 | Quita `JWT_ACCESS_SECRET` y lee el error de validación de configuración |
| 3 | 03 | Añade `campo?: string` y pásale `undefined` explícito: mira qué dice `exactOptionalPropertyTypes` |
| 4 | 04, 06 | Cambia un `import` de constructor a `import type` y aprende el error de inyección |
| 5 | 05 | Registra helmet **después** del limitador y comprueba las cabeceras de un `429` |
| 6 | 08, 09 | Escribe una migración a mano, aplícala y revierte la base de datos de test |
| 7 | Repaso | Dibuja de memoria el recorrido de `GET /projects` y compáralo con el código |

## Semana 2 — Tenancy, seguridad y capas

| Día | Capítulos | Rompe a propósito |
| --- | --- | --- |
| 8 | 10 | Sustituye `active()` por `scope()` en un repositorio y mira qué test cae |
| 9 | 10 (RLS) | Conéctate con `psql` como `qaflow_app` sin anunciar organización: 0 filas |
| 10 | 11 | Añade un campo al modelo de dominio y recorre todo lo que arrastra |
| 11 | 12 | Caduca un token a mano (`JWT_ACCESS_TTL=1s`) y observa el refresco del cliente |
| 12 | 13 | Quita un `@Roles` y comprueba qué test de permisos falla |
| 13 | 30 | Pon `httpOnly: false` y ejecuta el E2E: entiende **qué** aserción cae |
| 14 | Repaso | Explica en voz alta las cuatro capas de aislamiento, con sus límites |

## Semana 3 — Módulos y comportamiento

| Día | Capítulos | Rompe a propósito |
| --- | --- | --- |
| 15 | 14, 18 | Añade una clave desconocida a un `POST` y comprueba que Zod la descarta |
| 16 | 15, 19 | Lanza un `DomainError` nuevo y mira la forma de la respuesta |
| 17 | 16, 17 | Provoca un error a mitad de una transacción y comprueba el *rollback* |
| 18 | 20 | Intenta `UPDATE` sobre `audit_logs` en `psql` y lee el mensaje del trigger |
| 19 | 21, 22 | Crea un requisito, súbelo de versión y observa las claves generadas |
| 20 | 23 | Mueve una sección entre suites y busca la regla que lo impide o lo permite |
| 21 | 24 | Ejecuta un caso, cambia el caso, y comprueba que el resultado guarda su *snapshot* |

## Semana 4 — Trazabilidad, calidad y operación

| Día | Capítulos | Rompe a propósito |
| --- | --- | --- |
| 22 | 25, 26 | Archiva un caso y observa la caída de la cobertura en la matriz |
| 23 | 26 | Borra un requisito y comprueba en `psql` que sus enlaces desaparecieron |
| 24 | 27 | Pide crear un defecto externo sin integración configurada: el error debe ser explícito |
| 25 | 28, 29 | Rompe una regla de negocio y averigua **cuántos** tests lo detectan |
| 26 | 33, 34 | Cuenta las consultas de `GET /dashboard` y escribe una versión N+1 para comparar |
| 27 | 31, 32 | Construye la imagen Docker y rompe el CI a propósito con un error de lint |
| 28 | 35 | Haz un refactor de dos commits: forma y defecto separados |
| 29 | 37 | Empieza el ejercicio 1 (etiquetas como entidad) de punta a punta |
| 30 | 36, 39 | Graba tu resumen de dos minutos y compáralo con el guion |

## Al terminar los 30 días

Deberías poder hacer estas cinco cosas sin consultar el curso:

1. Añadir un módulo completo (contrato, migración, repositorio, servicio,
   controlador, tests) siguiendo las convenciones existentes.
2. Explicar por qué un endpoint devuelve `404` y no `403` entre organizaciones.
3. Diagnosticar "un cliente ve datos de otro" en un orden concreto: contexto →
   consulta → política.
4. Decidir dónde va una regla nueva: contrato, guard o servicio, y defenderlo.
5. Leer `technical-debt.md` y decir cuál cerrarías primero **con un argumento de
   negocio**, no de gusto.

Si alguna falla, el capítulo correspondiente no se estudió: se leyó.

## Cómo seguir después

- Haz los ejercicios 2 a 5 del capítulo 37, en orden.
- Cierra una entrada de deuda técnica de verdad, con su test y su documentación.
- Escribe un capítulo nuevo para una función que hayas añadido tú: si no puedes
  explicarla en la estructura de este curso, probablemente el diseño esté mal
  repartido. Ese fue el efecto secundario más útil de documentar así.

## Qué diría en una entrevista

> "Documenté el backend como un curso y luego lo estudié con un plan de 30 días
> cuyo paso obligatorio era romper algo a propósito cada día. Aprendí más de los
> errores forzados que de la lectura: el mensaje literal de un guard que se aplica
> mal, o de una política de RLS que devuelve cero filas sin fallar, es lo que
> reconoces después en producción a las tres de la mañana."

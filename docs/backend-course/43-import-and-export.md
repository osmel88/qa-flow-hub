# 43 — Import y export: procesar ficheros no confiables sin dejar estados parciales

## Concepto

Importar 2 000 casos es la diferencia entre un trial y una migración real. Pero
un CSV subido por un cliente es **entrada no confiable**: puede ser enorme,
estar mal codificado, ser un XLSX renombrado, contener fórmulas de Excel o
referencias a datos de otro proyecto. Y si falla a mitad, no puede dejar 1 200
casos creados y 800 no.

S3-F1 resuelve esto en dos tiempos:

1. **Dry run**: se sube el fichero, se valida fila a fila y se calcula un
   _plan_ normalizado. No se crea ningún caso.
2. **Commit**: se aplica _exactamente_ ese plan, en una transacción, o nada.

Código de referencia:

- `packages/shared/src/imports/import.contracts.ts` — formatos, estados, códigos de issue.
- `apps/api/src/modules/imports/parsing/csv-input.ts` — guarda de bytes, UTF-8, binarios, `csv-parse`.
- `apps/api/src/modules/imports/parsing/qaflow-csv.parser.ts` y `testrail-csv.parser.ts` — dialectos.
- `apps/api/src/modules/imports/parsing/case-draft.ts` — validación de campos.
- `apps/api/src/modules/imports/import-plan.ts` — plan persistido y huella.
- `apps/api/src/modules/imports/imports.service.ts` — dry run y commit.
- `apps/api/src/modules/exports/` — writer CSV, exports y cabeceras.
- `apps/api/prisma/migrations/20261025100000_import_jobs/migration.sql`.
- ADR `docs/adr/0016-printable-html-instead-of-server-pdf.md`.

## Capas de defensa antes de parsear

El orden importa: cada capa descarta barato lo que la siguiente procesaría caro.

1. **Tamaño**: el parser multipart corta en `IMPORT_MAX_BYTES`; si el fichero
   llega truncado se rechaza, nunca se procesa "lo que llegó".
2. **Firma binaria**: `PK\x03\x04` (XLSX/ZIP), `%PDF`, gzip → 400.
3. **Codificación**: BOM UTF-16 o bytes NUL → 400. Luego
   `new TextDecoder('utf-8', { fatal: true })`: un byte inválido lanza en vez de
   convertirse en `�` silenciosamente.
4. **Forma**: `csv-parse` con `max_record_size` (64 KiB), comillas estrictas y
   un tope de filas y columnas. Un CSV mal formado devuelve un único issue
   `MALFORMED_CSV` con la línea.

Pregunta de entrevista: _¿por qué no validar el tamaño después de leer el
body?_ Porque entonces ya lo tienes en memoria: el límite tiene que estar en el
stream.

## Dialectos: mismo modelo, cabeceras distintas

Los dos formatos producen el mismo `RawCase[]`. Las columnas se reconocen
**por nombre**, no por posición, porque quien exporta desde TestRail elige qué
columnas incluir. Columnas desconocidas → warning `UNKNOWN_COLUMN`, nunca
error. Los pasos van en filas adicionales: una fila con `ref` vacío (TestRail)
o con el mismo `ref` (qa-flow) añade un paso al caso anterior; una fila de paso
sin caso previo es `ORPHAN_STEP_ROW`.

Ejercicio: añade un alias de columna y su test en `parsing.test.ts`.

## Validación fila a fila

Cada problema es `{ row, column, code, severity, message }`. `row` es la línea
del fichero (la cabecera es la 1), así el usuario puede ir directo a la celda.
Los **errores** impiden el commit; los **warnings** (duplicado, columna
desconocida, prioridad desconocida) no. Se guardan como máximo 1 000 issues y
el total en `issueCount`, para que un fichero roto no infle la fila del job.

## Por qué el plan se persiste

Alternativa ingenua: el commit vuelve a recibir el fichero. Problemas: el
usuario podría subir otro distinto del que revisó, y se parsea dos veces.

`ImportJob.plan` guarda los borradores normalizados más una **huella**
(`sha256`) de las decisiones: qué suites y secciones se crean, qué casos se
omiten como duplicados y qué requisitos se enlazan. El fichero original no se
guarda; solo su checksum.

## El commit: lock, re-resolver, comparar

```text
BEGIN
  pg_advisory_xact_lock(hashtext('import:<org>:<project>'))
  UPDATE import_jobs SET status='committed' WHERE id=$1 AND status='ready'   -- un solo ganador
  re-resolver suites, secciones, duplicados y requisitos con el estado actual
  si la huella ≠ la del dry run → 409 IMPORT_STALE (rollback)
  reservar N claves de caso en el contador del proyecto
  crear suites, secciones, casos, pasos, links
  audit
COMMIT
```

- El **advisory lock por proyecto** serializa dos imports simultáneos en el
  mismo proyecto: dos imports que crean la sección `Auth` no acaban con dos
  secciones `Auth`.
- El **UPDATE condicional** hace que, de dos commits concurrentes del mismo
  job, uno reciba 200 y el otro 409.
- **Re-resolver dentro de la transacción** detecta que alguien creó un caso
  igual entre el dry run y el commit; en vez de duplicarlo, el plan ya no
  coincide y se pide un dry run nuevo.
- Si cualquier insert falla, el rollback deshace **también** el contador de
  claves: no quedan huecos `WEB-C-12…` sin caso.

Los tests de integración fuerzan este rollback con un trigger que falla a
mitad y comprueban que no queda ningún caso, sección ni enlace.

## Aislamiento

- Las claves de `references` se buscan solo en el proyecto del import; una
  clave de otro proyecto o tenant es `UNKNOWN_REFERENCE`, nunca un enlace.
- Cualquier miembro con `test_design.import` ve el historial, pero un job solo
  lo confirma quien lo creó, y solo si sigue teniendo
  `test_design.import` en ese proyecto.
- `import_jobs` tiene RLS y `qaflow_app` no puede borrar filas.
- Los proyectos archivados rechazan el import.

## Exports y CSV injection

Una celda que empieza por `=`, `+`, `-`, `@`, tab o CR se ejecuta como fórmula
al abrir el CSV en Excel (`=HYPERLINK(...)`). El writer la prefija con `'`
(`neutralizeCsvFormula`); el parser de import la restaura, así un export
reimportado conserva el texto original. Además: BOM UTF-8 para que Excel lea
los acentos, `Content-Disposition` con nombre saneado y `filename*` RFC 5987,
`nosniff` y `no-store`. El export de un run sale de los **snapshots**
(ADR 0009), no del caso vivo.

La revisión final de S3-F1 encontró que el disparador no siempre está en la
primera posición: algunas hojas de cálculo recortan los espacios al importar,
así que ` =1+1` o `\n@cmd` son tan peligrosos como `=1+1`. Por eso
`isCsvFormulaLike` salta antes los espacios, NBSP y saltos de línea iniciales, y
`restoreCsvFormula` usa exactamente la misma regla para seguir siendo la
inversa. Moraleja: una lista de "caracteres peligrosos" debe probarse contra
las variantes que el consumidor normaliza, no solo contra la forma canónica.

Otras dos lecciones de esa revisión:

- **Normalizar antes de comparar.** `Añadir` puede llegar en NFC (un código
  para `ñ`) o NFD (`n` + tilde combinada, típico de macOS). Son el mismo texto
  para una persona y distintos para `===`; `normalizeTitle` aplica
  `normalize('NFC')` antes de detectar duplicados.
- **No reparar entradas ambiguas en silencio.** `Auth >  > Password` podría
  interpretarse como `Auth > Password`, pero también puede ser un nivel
  borrado por error. El validador lo reporta (`REQUIRED` en `section`) y deja
  que la persona decida.

## PDF sin servidor

Ver ADR 0016: un Chromium headless en la API es una dependencia de 150 MB, un
sandbox y una cola. La vista imprimible reutiliza los mismos endpoints
autenticados, así que no puede enseñar nada que el usuario no vea ya.

## Qué queda fuera

Deuda 38: import síncrono, export en memoria, duplicados por título, sin
retención de jobs.

## Ejercicios

1. Haz que el export de casos se envíe en streaming con `reply.raw` sin perder
   las cabeceras. ¿Qué pasa con el audit si el cliente corta la descarga?
2. Persiste el `ID` de TestRail como referencia externa y úsalo para detectar
   duplicados. ¿Qué cambia en la huella del plan?
3. Escribe un test que demuestre que dos imports concurrentes en proyectos
   distintos **no** se bloquean entre sí.

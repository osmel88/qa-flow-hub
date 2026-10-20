# 45 — API keys e ingestión de reportes: credenciales de máquina y escrituras todo-o-nada

## Concepto

Un pipeline de CI no es una persona. No debe usar un refresh token (deuda 20):
caduca a los 30 días, pertenece a alguien y puede hacer todo lo que ese alguien
puede hacer. En S3-F3 el CI recibe una **API key de proyecto** con un único
scope, `results:ingest`, y la usa para subir reportes JUnit XML o Playwright
JSON. La API los convierte en resultados de un test run (ADR 0018).

## 1. Un token que solo se ve una vez

```text
qfh_AbCdEfGhIjKl_<43 caracteres base64url>
    └── prefijo ─┘ └──────── secreto ────────┘
```

- `generateToken()` (`apps/api/src/modules/automation/api-key-token.ts`) crea
  el prefijo con _rejection sampling_ (62 no divide 256: `byte % 62` sesgaría
  la distribución) y el secreto con 32 bytes de `randomBytes`.
- En la base de datos solo se guardan `prefix` y `secretHash = sha256(token)`.
  Con 256 bits de entropía no hace falta bcrypt/argon2: un KDF lento protege
  contraseñas humanas débiles, no secretos aleatorios.
- `tokenMatches()` compara con `timingSafeEqual`: el tiempo de respuesta no
  revela cuántos bytes coinciden.
- `POST /projects/:id/api-keys` devuelve `{ key, token }`; ninguna otra
  respuesta, log ni auditoría contiene el token.

**Ejercicio:** busca en `ingestion.int-spec.ts` el test que recorre `api_keys`
y `audit_logs` comprobando que el token no aparece. ¿Qué pasaría si alguien
añadiera `token` a `ApiKeyView`?

## 2. Resolver el tenant sin sesión

Una ruta `@Public()` no tiene organización activa, y con RLS una consulta sin
`app.current_organization` no ve ninguna fila. Es un problema del huevo y la
gallina: para saber la organización hay que leer la key, y para leer la key hay
que conocer la organización.

La solución es una función mínima `SECURITY DEFINER`:

```sql
api_key_organization_for_prefix(p_prefix) RETURNS TEXT  -- solo organizationId
```

Después, `TenantContextService.runForOrganization()` activa RLS para esa
organización y **dentro** se comprueban hash, revocación, expiración, scope y
proyecto. La función no devuelve el hash: aunque se abusara de ella, solo dice
"este prefijo existe en alguna organización". Por eso todos los fallos
(desconocido, manipulado, revocado, caducado, organización borrada) responden
el mismo 401.

## 3. Revocación inmediata: locks de fila

```text
ingestión:  BEGIN … SELECT … FROM api_keys WHERE id = $1 FOR SHARE … COMMIT
revocación: BEGIN … SELECT … FOR UPDATE; now = new Date(); UPDATE revokedAt … COMMIT
```

`FOR UPDATE` espera a las ingestiones en curso y las posteriores ven la
revocación. La revisión de esta fase encontró un bug sutil: `revokedAt` se
calculaba **antes** de esperar el lock, así que podía quedar un reporte con
`createdAt > revokedAt`. Ahora el timestamp se toma después del lock
(`ApiKeysRepository.lockForRevoke`).

## 4. XML no confiable

1. Límite de bytes en el multipart, antes de leer el fichero.
2. `TextDecoder('utf-8', { fatal: true })`: bytes inválidos → `REPORT_NOT_UTF8`.
3. Cualquier `<!DOCTYPE`, `<!ENTITY`, `<!ELEMENT`, `<!ATTLIST`, `<!NOTATION`
   → `REPORT_DTD_FORBIDDEN`. Sin DTD no hay XXE ni _billion laughs_.
4. `saxes` en streaming, profundidad máxima 32 y límite de tests.

Cada error es `400 INVALID_REPORT` con `details[0].code`, o `413
REPORT_TOO_LARGE`. El CI puede distinguir "arregla el reporte" de "reintenta".

## 5. Todo o nada, e idempotencia

El parseo ocurre fuera de la transacción (un reporte inválido no abre ninguna).
Después, en **una** transacción con `pg_advisory_xact_lock('ingest:<project>')`:
re-validar la key, crear o reutilizar el run, añadir run cases con el snapshot
del caso (ADR 0009), crear resultados, el `IngestionReport`, `lastUsedAt` y la
auditoría. Si algo falla, PostgreSQL deshace todo.

Idempotencia: `(projectId, idempotencyKey)` es único. Sin cabecera se usa
`sha256:<checksum>`; un reenvío devuelve el reporte original con
`duplicate: true`, y la misma clave con otro contenido responde 409. El lock por
proyecto convierte diez reenvíos simultáneos en un registro y nueve duplicados.

## 6. Mapping

- Un test se asocia a un caso si su nombre, clase, tags, anotaciones o
  propiedades contienen la key `WEB-C-12` (`caseKeysIn`, con lookarounds para
  no aceptar `XWEB-C-1`).
- Varios tests del mismo caso se agregan: un fallo lo hace `failed`; solo es
  `skipped` si todos lo son; la duración es la suma.
- Los tests sin coincidencia se informan, nunca crean casos.

## Para estudiar

- `ingestion.service.ts`: sigue el orden exacto de validaciones.
- `ingestion.int-spec.ts`: concurrencia (reenvíos, mismo run, revocación) y
  cross-tenant.
- Deuda 40: qué queda pendiente y por qué.

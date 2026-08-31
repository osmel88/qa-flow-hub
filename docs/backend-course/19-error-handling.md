# 19 — Manejo de errores

## Concepto

Un error es información. La pregunta de diseño no es "cómo evito que se rompa"
sino **quién recibe qué**: el cliente necesita saber qué hacer a continuación, el
operador necesita poder diagnosticar, y el atacante no debe aprender nada.

En este proyecto hay una jerarquía de errores de dominio, un filtro único que los
traduce a HTTP y un envelope de respuesta uniforme.

## Qué problema resuelve

Sin una estrategia, un backend acumula tres patologías a la vez:

1. **Fugas.** Un `500` con el mensaje de PostgreSQL revela nombres de tablas,
   columnas e incluso valores de otras filas.
2. **Respuestas irregulares.** Un endpoint devuelve `{message}`, otro
   `{error}`, otro texto plano. El cliente escribe un `if` por endpoint.
3. **Acoplamiento al transporte.** Servicios que lanzan `HttpException` no se
   pueden reutilizar fuera de HTTP.

## Archivos reales

```
apps/api/src/errors/domain-error.ts          jerarquía
apps/api/src/errors/all-exceptions.filter.ts traducción a HTTP
apps/api/src/common/pipes/zod-validation.pipe.ts errores de validación
apps/api/src/common/middleware/request-context.middleware.ts requestId
docs/api-conventions.md                      el contrato hacia fuera
```

## La jerarquía

```ts
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  protected constructor(message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
  }
}
```

El constructor es `protected` a propósito: nadie lanza un `DomainError` genérico,
sino uno de sus hijos, que traen `code` y `httpStatus` fijos. Cada subclase es una
categoría de fallo, no un mensaje suelto:

| Clase | Código | HTTP | Cuándo |
| --- | --- | --- | --- |
| `ValidationError` | `VALIDATION_ERROR` | 400 | El cuerpo no cumple el esquema |
| `UnauthenticatedError` | `UNAUTHENTICATED` | 401 | No hay identidad válida |
| `ForbiddenError` | `FORBIDDEN` | 403 | Hay identidad, falta permiso |
| `NotFoundError` | `NOT_FOUND` | 404 | No existe **o no es tuyo** |
| `ConflictError` | `CONFLICT` | 409 | Choca con el estado actual |
| `DuplicateResourceError` | `DUPLICATE_RESOURCE` | 409 | Viola una unicidad |
| `RateLimitedError` | `RATE_LIMITED` | 429 | Demasiados intentos |

El `code` es lo que consume el cliente; el `message` es para humanos y puede
cambiar sin romper a nadie.

## 403 frente a 404: una decisión de seguridad

La regla en este producto es explícita:

- **404** cuando el recurso pertenece a otra organización;
- **403** cuando el recurso es tuyo pero tu rol no alcanza.

Devolver 403 en el primer caso confirmaría la existencia de un proyecto ajeno.
El repositorio lo hace automático: filtra por organización, no encuentra nada,
el servicio lanza `NotFoundError`. La política no depende de que nadie se acuerde
de aplicarla.

```ts
it('hides another organization behind a 404, not a 403', async () => {
  const response = await request('GET', `/api/v1/projects/${projectId}`, { ...otherOrg });
  expect(response.statusCode).toBe(404);
});
```

## El envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request failed validation",
    "requestId": "b3f1c2...",
    "details": [{ "path": "key", "message": "Use 2 to 8 characters..." }]
  }
}
```

Cuatro campos y ninguno accidental. `code` es estable y programable. `message`
es legible. `requestId` es el puente entre lo que ve el usuario y lo que ve el
operador: aparece en la respuesta y en cada línea de log de esa petición, así que
un ticket con ese identificador se resuelve con un `grep`. `details` solo existe
en errores de validación, y solo lleva rutas de campo y mensajes: nunca los
valores enviados, que podrían ser la contraseña.

## El filtro: un único punto de traducción

```ts
if (exception instanceof DomainError) {
  return this.send(reply, exception.httpStatus, exception.code, exception.message, requestId, details);
}
if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2002') {
  return this.send(reply, 409, 'DUPLICATE_RESOURCE', 'A resource with these values already exists', requestId);
}
// cualquier otra cosa
this.logger.error(...);
return this.send(reply, 500, 'INTERNAL_ERROR', 'An unexpected error occurred', requestId);
```

Lo importante es la última rama. Un error desconocido **se registra completo con
su stack y se responde con un mensaje genérico**. Esa asimetría es toda la
estrategia: el operador tiene lo que necesita, el cliente tiene un identificador
con el que preguntar, y el atacante no obtiene un mapa del esquema.

El `P2002` de Prisma se traduce porque una violación de unicidad es un conflicto
legítimo del cliente, no un fallo del servidor. No se filtran otros códigos de
Prisma: si `P2003` (clave foránea) llega al filtro, es un bug nuestro y merece un
500 ruidoso, no un 400 tranquilizador.

## Errores de validación

El pipe convierte el `ZodError` en un `ValidationError` con detalle por campo:

```ts
throw new ValidationError(
  'The request failed validation',
  error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
);
```

Un formulario puede marcar el campo exacto. Y como es el pipe quien traduce, el
resto del código nunca ve un `ZodError`.

## Qué NO se cuenta

Casos donde el mensaje es deliberadamente pobre:

- **Login fallido**: mismo código, mismo texto y **mismo tiempo** tanto si la
  cuenta no existe como si la contraseña es incorrecta.
- **Token de invitación**: inexistente, revocado o ya usado producen el mismo
  404. Solo la expiración se distingue, porque la acción del usuario es distinta
  (pedir otro) y el token era legítimo.
- **Recurso de otro tenant**: 404, como arriba.

Nótese la excepción consciente: el registro **sí** revela que un email ya está en
uso, porque no hay forma de registrar a alguien sin decírselo. Se mitiga con rate
limiting, no con un mensaje ambiguo que rompería el formulario.

## Comandos

```bash
# Provocar cada categoría
curl -si localhost:3000/api/v1/projects | jq .error.code                     # UNAUTHENTICATED
curl -si -X POST localhost:3000/api/v1/organizations -H "authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"name":"x"}' | jq .error          # VALIDATION_ERROR

# Seguir un requestId por los logs
docker compose logs api | grep "$REQUEST_ID"
```

## Errores comunes

**Lanzar `HttpException` en un servicio.** Ata el dominio al transporte y
esparce el mapeo de estados por todo el código.

**Devolver `error.message` de una excepción desconocida.** Es la fuga clásica: el
mensaje de PostgreSQL incluye la sentencia y a veces los valores.

**Usar 500 para errores del cliente.** Ensucia las alertas hasta que nadie las
mira. Un 4xx es una respuesta normal del sistema; un 5xx es un fallo nuestro.

**Registrar el cuerpo completo de la petición al fallar.** Ahí van contraseñas y
tokens.

**`catch` que se traga el error.** Si no puedes manejarlo, no lo captures. La
única excepción aquí es la auditoría fuera de transacción, y está justificada por
escrito.

## Preguntas de repaso

1. ¿Por qué el constructor de `DomainError` es `protected`?
2. ¿Cuándo devuelve la API 403 y cuándo 404, y qué ataque evita esa regla?
3. ¿Qué contiene y qué nunca contiene el campo `details`?
4. ¿Por qué se traduce `P2002` de Prisma y no los demás códigos?
5. ¿Para qué sirve `requestId` exactamente, y en cuántos sitios aparece?

## Ejercicios

1. Añade `PreconditionFailedError` (412) y úsalo para el bloqueo optimista de un
   caso de prueba.
2. Lanza un `TypeError` a propósito dentro de un servicio y comprueba qué recibe
   el cliente y qué queda en los logs. Verifica que no coinciden.
3. Escribe un test que afirme que ninguna respuesta de error incluye la palabra
   `prisma`.
4. Mide el tiempo de `POST /auth/login` con email inexistente y con contraseña
   incorrecta, veinte veces cada uno. Compara las medias.

## Qué diría en una entrevista

> Los servicios lanzan errores de dominio con un código estable y un estado HTTP
> asociado; un único filtro los traduce y envuelve toda respuesta de error en la
> misma forma, con un requestId que también está en los logs de esa petición. Lo
> desconocido se registra entero y se responde genérico: el operador puede
> diagnosticar y el cliente no aprende nada del esquema. Y hay una regla de
> seguridad explícita en los códigos: el recurso de otro tenant es 404, no 403,
> porque un 403 confirmaría que existe. Como el filtro por organización lo aplica
> el repositorio, esa política sale sola.

## MVP frente a futuro

| Decisión | Ahora | Después |
| --- | --- | --- |
| Catálogo de códigos | Enum en el código y `api-conventions.md` | Publicado en OpenAPI por endpoint |
| Correlación | `requestId` propio | Trazas OpenTelemetry con `traceparent` |
| Alertas | Logs de nivel error | Sentry con agrupación por `code` |
| i18n de mensajes | Solo inglés | El cliente traduce por `code`, no por texto |

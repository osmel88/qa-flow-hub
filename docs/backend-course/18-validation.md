# 18 — Validación de entrada

## Concepto

Validar es rechazar lo que no cumple el contrato **antes** de que llegue a la
lógica de negocio. En este proyecto se hace con [Zod](https://zod.dev), y los
esquemas viven en `packages/shared`, así que el mismo objeto valida el
formulario del navegador y el cuerpo de la petición en el servidor.

## Qué problema resuelve

Tres a la vez, y solo el primero es evidente:

1. **Datos imposibles.** Un correo sin arroba, una página cero.
2. **Normalización.** `"  Ada@Example.TEST "` y `"ada@example.test"` deben ser
   la misma cuenta. Si no se normaliza en la entrada, el índice único no sirve
   de nada.
3. **Mass assignment.** El cliente que envía `{ isActive: false }` en un
   registro no debe poder tocar esa columna.

## El pipe

```ts
// apps/api/src/common/pipes/zod-validation.pipe.ts
transform(value: unknown, _metadata: ArgumentMetadata): T {
  try {
    return this.schema.parse(value);
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      throw new ValidationError('The request failed validation',
        error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
    }
    throw error;
  }
}
```

Lo importante es que **devuelve** el resultado, no un booleano: el handler
recibe el valor ya transformado. `emailSchema` pasa a minúsculas y recorta
espacios, así que el servicio no puede usar por error el valor crudo.

Y esa misma sustitución es la defensa contra mass assignment: los objetos de Zod
descartan claves desconocidas por defecto.

```ts
it('strips unknown fields instead of trusting them', async () => {
  const response = await post('/api/v1/auth/register', {
    ...REGISTER, isActive: false, failedLoginAttempts: 99,
  });

  expect(response.statusCode).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'ada@example.test' } });
  expect(user.isActive).toBe(true);
  expect(user.failedLoginAttempts).toBe(0);
});
```

Con un DTO de clase y `class-validator` esto también se consigue, pero hay que
acordarse de `forbidNonWhitelisted`. Aquí es el comportamiento por defecto.

## Por qué Zod y no class-validator

- **Un esquema, dos usos.** El formulario de React usa exactamente el mismo
  objeto. No hay dos definiciones que puedan divergir.
- **El tipo se deriva del esquema**, no al revés:
  `type RegisterInput = z.infer<typeof registerSchema>`. Es imposible que el
  tipo y la validación dejen de coincidir.
- **Transformaciones de primera clase**: `.trim()`, `.toLowerCase()`,
  `.coerce.number()`.
- Sin decoradores ni `reflect-metadata`, así que funciona igual en el navegador.

## Validar no es lo mismo en cada endpoint

```ts
// packages/shared/src/auth/auth.contracts.ts
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
```

El login **no** aplica la política de contraseñas. Dos motivos: la contraseña
guardada puede ser anterior a un endurecimiento de la política, y decirle a
quien intenta entrar que su contraseña "es demasiado corta" es información
gratis para un atacante.

El límite superior sí está, y no es cosmético: argon2 procesa lo que le den, y
una contraseña sin límite es una forma barata de quemar CPU en el endpoint más
expuesto.

## Los tres niveles de validación

| Nivel | Qué comprueba | Ejemplo |
| --- | --- | --- |
| Esquema (Zod) | Forma y tipo | El correo parece un correo |
| Servicio | Reglas de negocio | No se puede quitar al último propietario |
| Base de datos | Invariantes | Índice único de invitaciones pendientes |

Los tres son necesarios. El esquema no sabe si el correo ya existe; el servicio
no puede ganar una carrera contra otra petición; la base de datos no puede dar
un mensaje de error decente.

## La respuesta de error

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request failed validation",
    "details": [{ "path": "password", "message": "Password must be at least 12 characters" }],
    "requestId": "..."
  }
}
```

`path` es lo que permite al formulario marcar el campo concreto en lugar de
mostrar un aviso genérico arriba del todo.

## Errores comunes

- **Validar solo en el frontend.** `curl` existe.
- **Devolver un booleano** en vez del valor transformado: se pierde la
  normalización.
- **Permitir claves desconocidas.**
- **Aplicar la política de contraseñas en el login.**
- **Validar dos veces con dos definiciones** que acaban divergiendo.
- **Filtrar detalles internos** en el mensaje de error.

## Preguntas de repaso

1. ¿Por qué el pipe devuelve el valor en vez de validar y seguir?
2. ¿Cómo protege Zod contra mass assignment sin configuración extra?
3. ¿Por qué el login no comprueba la política de contraseñas?
4. ¿Qué valida la base de datos que el servicio no puede garantizar?

## Ejercicios

1. Añade `phone` opcional al perfil con validación E.164 y una prueba.
2. Envía `{"page": "abc"}` a un endpoint paginado y observa el error; mira cómo
   `z.coerce.number()` cambia el resultado.
3. Escribe una prueba que envíe un campo extra a `PATCH /auth/me` y demuestre
   que se ignora.

## Qué diría en una entrevista

> "Los esquemas de Zod están en un paquete compartido, así que el formulario y
> la API validan con la misma definición y el tipo de TypeScript se deriva del
> esquema. El pipe sustituye el valor por el resultado del parseo, y eso me da
> dos cosas gratis: normalización —el correo llega ya en minúsculas, que es lo
> que hace útil al índice único— y protección contra mass assignment, porque Zod
> descarta claves desconocidas por defecto."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Cuerpo y query | Zod | Igual |
| OpenAPI | Decorators de Swagger | Generar el esquema desde Zod |
| Errores | `code`, `message`, `details` | Mensajes traducibles |
| Ficheros | No aplica | Validar tipo MIME y tamaño real |

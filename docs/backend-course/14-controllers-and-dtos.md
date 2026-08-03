# 14 — Controladores y DTOs

## Concepto

Un controlador traduce HTTP a una llamada de dominio y nada más. Recibe una
petición, obtiene datos ya validados, llama a un servicio y devuelve el
resultado. No decide reglas de negocio, no consulta la base de datos y no
construye SQL.

Un DTO (*Data Transfer Object*) es la forma de los datos que cruzan la frontera
de la API: lo que entra y lo que sale. En este proyecto los DTOs de entrada son
esquemas Zod que viven en `packages/shared`, y los de salida son interfaces
`*View`.

## Qué problema resuelve

Tres problemas concretos, y ninguno es estético.

**1. Que el transporte no contamine el dominio.** Si el servicio recibe un
`FastifyRequest`, ese servicio ya no se puede llamar desde un consumidor de
eventos, un cron o un test sin fabricar una petición falsa. Mantener el
controlador delgado es lo que permite que `InvitationsService.accept()` se llame
tanto desde `POST /organizations/invitations/accept` como desde el registro.

**2. Que la entidad de base de datos no sea la respuesta.** Devolver la fila de
Prisma tal cual es cómodo un día y una fuga el siguiente: el día que alguien
añade `passwordHash` a `User`, aparece en la respuesta. Las interfaces `*View`
son una lista blanca escrita a mano.

**3. Que el cliente y el servidor no se desincronicen.** El esquema de entrada es
el mismo objeto en el backend y en el frontend, porque está en un paquete
compartido.

## Archivos reales

```
packages/shared/src/organizations/organization.contracts.ts   entrada + salida
packages/shared/src/projects/project.contracts.ts             entrada + salida
apps/api/src/modules/projects/projects.controller.ts          traducción HTTP
apps/api/src/modules/organizations/organizations.controller.ts
apps/api/src/common/pipes/zod-validation.pipe.ts              validación
apps/api/src/modules/auth/decorators/current-user.decorator.ts
```

## Flujo por capas

```
POST /api/v1/projects
  │
  ├─ middleware   abre el contexto de petición (requestId, IP, user-agent)
  ├─ guards       usuario → organización activa → rol
  ├─ pipe         createProjectSchema.parse(body)  ← valida y NORMALIZA
  ├─ controlador  projects.create(body)            ← 3 líneas
  ├─ servicio     reglas: clave duplicada, auditoría
  ├─ repositorio  where: { organizationId, ... }
  └─ interceptor  serialización + envelope de error si algo falló
```

## El controlador completo de un endpoint

```ts
@Roles('organization_owner', 'organization_admin')
@Post()
@ApiOperation({ summary: 'Create a project' })
create(@Body(zodBody(createProjectSchema)) body: CreateProjectInput) {
  return this.projects.create(body);
}
```

Cuatro cosas dichas de forma declarativa: quién puede llamar (`@Roles`), qué
método y ruta, qué forma tiene el cuerpo, y qué documentación aparece en
OpenAPI. La lógica está en el servicio.

Fíjate en lo que **no** aparece: `organizationId`. El controlador no lo pasa
porque el repositorio lo toma del contexto. Un parámetro que no existe no se
puede rellenar mal.

## DTO de entrada: el esquema es la validación y la normalización

```ts
export const projectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(8)
  .regex(/^[A-Z][A-Z0-9]*$/, 'Use 2 to 8 characters: letters and digits, starting with a letter');
```

`toUpperCase()` no es una comodidad: la base de datos tiene un `CHECK ("key" =
upper("key"))`. El esquema y la restricción SQL dicen lo mismo en dos capas, y
el usuario que escribe `web` obtiene `WEB` en lugar de un error.

Y el detalle que evita una clase entera de bugs de seguridad:

```ts
export const updateProjectSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(2000).nullish(),
});
```

`status` no está. Archivar tiene reglas —fija `archivedAt`, y un proyecto
archivado rechaza escrituras—, así que es una transición con su propio endpoint,
no un campo que se teclea. Un `PATCH` con `{"status":"archived"}` pierde el campo
en el pipe.

## DTO de salida: lista blanca explícita

```ts
export function toProjectView(project: Project): ProjectView {
  return {
    id: project.id,
    name: project.name,
    key: project.key,
    description: project.description,
    status: project.status,
    archivedAt: project.archivedAt?.toISOString() ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}
```

Los contadores internos (`requirementCounter`, `testCaseCounter`) y
`organizationId` no salen. Son detalle de implementación, y `organizationId`
además es información sobre el tenant que el cliente ya conoce por la cabecera.

Las fechas salen como ISO 8601 en string, no como `Date`. Un `Date` en JSON es un
string de todos modos; hacerlo explícito evita que el frontend reciba a veces uno
y a veces otro.

## El caller tipado

El controlador necesita saber quién pregunta. En lugar de `request.user`, hay un
decorador de parámetro:

```ts
export class CurrentUserContext {
  constructor(
    readonly userId: string,
    readonly email: string,
    private readonly tenant?: { organizationId: string; role: OrganizationRole },
  ) {}

  get organizationId(): string {
    if (this.tenant === undefined) {
      throw new UnauthenticatedError('No active organization for this request');
    }
    return this.tenant.organizationId;
  }
}
```

Es una clase y no un objeto plano por una razón concreta. Hay dos tipos de rutas
autenticadas: las que tienen organización activa y las que no
(`@SkipOrganization()`, como crear una organización). Con un objeto plano,
`organizationId` sería `string | undefined` en todas partes y cada controlador
tendría un `!` o un `?.`. Con accesores, leerlo donde no existe lanza un 401 en
vez de propagar `undefined` hasta una consulta sin filtro.

## Query strings: por qué la paginación usa `coerce`

```ts
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
```

En una query string todo llega como texto: `?page=2` es `"2"`. Sin `coerce`,
`z.number()` fallaría siempre. Y `max(100)` no es decoración: sin él,
`?pageSize=100000` es un ataque de agotamiento de memoria escrito por el propio
cliente. El test lo comprueba:

```ts
it('rejects a page size above the maximum instead of honouring it', async () => {
  const response = await request('GET', '/api/v1/projects?pageSize=100000', { ... });
  expect(response.statusCode).toBe(400);
});
```

## Comandos

```bash
# Ver el contrato generado
npm run dev -w @qa-flow-hub/api
open http://localhost:3000/docs

# Probar un endpoint con validación fallida
curl -s -X POST localhost:3000/api/v1/projects \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -H "x-organization-id: $ORG" \
  -d '{"name":"x","key":"a b"}' | jq
```

## Errores comunes

**Poner reglas de negocio en el controlador.** El síntoma es un `if` que consulta
la base de datos. Si el controlador tiene más de cinco líneas, algo bajó de capa
por error.

**Devolver la entidad de Prisma.** Funciona hasta que el esquema cambia. La
prueba de que importa es el test `expect(response.json().data[0]).not
.toHaveProperty('passwordHash')`.

**Aceptar el `organizationId` del cliente.** Es el error más grave posible en un
producto multi-tenant. Aquí es imposible porque ningún método de repositorio lo
recibe.

**Usar `class-validator` y Zod a la vez.** Se puede, y produce dos fuentes de
verdad sobre la misma forma. Elige una; aquí es Zod porque se comparte con el
frontend.

**Olvidar `@HttpCode`.** Nest devuelve 201 para todo `POST`. `POST /logout` que
responde 201 es raro; `POST /login` que responde 201 también.

## Preguntas de repaso

1. ¿Por qué `createProjectSchema` no incluye `organizationId`?
2. ¿Qué pasa exactamente con `{"role":"organization_owner"}` enviado a
   `PATCH /auth/me`, y en qué capa ocurre?
3. ¿Por qué archivar es `POST /projects/:id/archive` y no
   `PATCH /projects/:id`?
4. ¿Qué se rompería si `CurrentUserContext` fuera un objeto plano con
   `organizationId?: string`?
5. ¿Por qué las fechas salen como string ISO y no como `Date`?

## Ejercicios

1. Añade `GET /projects/:id/summary` que devuelva el proyecto y el número de
   casos. Escribe primero el `*View`, después el controlador.
2. Intenta enviar `{"key":"WEB","testCaseCounter":900}` a `POST /projects` y
   comprueba en la base de datos que el contador es 0. Localiza la línea exacta
   que lo descartó.
3. Cambia `MAX_PAGE_SIZE` a 5 y observa qué test falla. Eso te dice si el límite
   está cubierto.
4. Añade un campo `tags: string[]` al DTO de creación de proyecto sin tocar el
   esquema Prisma y observa dónde falla. Eso te enseña dónde está la frontera.

## Qué diría en una entrevista

> Los controladores son adaptadores HTTP de tres líneas: validan con un pipe de
> Zod, llaman al servicio y devuelven. Los esquemas de entrada viven en un
> paquete compartido con el frontend, así que el contrato no se puede
> desincronizar, y Zod descarta claves desconocidas por defecto, lo que nos da
> protección contra mass assignment sin escribir código específico. Las
> respuestas nunca son entidades de Prisma sino funciones de proyección
> explícitas; eso es lo que garantiza que añadir una columna sensible al esquema
> no la publique. Y las transiciones de estado con reglas —archivar un
> proyecto— son endpoints propios en lugar de campos editables, para que la
> auditoría registre la intención y no un diff.

## MVP frente a futuro

| Decisión | Ahora | Después |
| --- | --- | --- |
| Validación | Zod en pipe manual por endpoint | Considerar un `ZodValidationPipe` global con metadatos |
| OpenAPI | `@ApiOperation` a mano | Generar esquemas desde Zod (`zod-to-openapi`) |
| Serialización | Funciones `toXView` | Igual; los interceptores automáticos ocultan errores |
| Versionado | `/api/v1` por URI | Igual hasta que exista un cliente externo que rompa |

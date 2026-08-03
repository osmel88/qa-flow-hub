# 13 — Autorización y roles

## Concepto

Autorizar es decidir si **este** usuario puede hacer **esta** acción sobre
**este** recurso. Sucede después de autenticar y es donde está la mayoría de los
fallos de seguridad reales: no en criptografía rota, sino en un endpoint que
nadie protegió.

## Qué problema resuelve

Tres preguntas distintas, y confundirlas es el origen del desastre:

1. ¿Quién eres? → capítulo 12.
2. ¿Para qué **organización** actúas y perteneces a ella? → este capítulo.
3. ¿Tu **rol** te permite esta operación? → este capítulo.

## La cadena de guards

```ts
// apps/api/src/modules/auth/auth.module.ts
{ provide: APP_GUARD, useClass: JwtAuthGuard },
{ provide: APP_GUARD, useClass: ActiveOrganizationGuard },
{ provide: APP_GUARD, useClass: RolesGuard },
```

Nest ejecuta los `APP_GUARD` en orden de registro, así que **esta lista es la
tubería de seguridad**: el primero resuelve el usuario, el segundo resuelve el
tenant usando ese usuario, el tercero comprueba el rol que resolvió el segundo.
Reordenarlos rompe la cadena de forma silenciosa.

Son **globales**, y esa es la decisión importante: autenticar es el
comportamiento por defecto y `@Public()` es la excepción. Con guards opcionales,
olvidar un decorador **publica** un endpoint; con guards globales, olvidarlo
solo lo rompe ruidosamente. El modo de fallo correcto es el ruidoso.

## Guard 2 — organización activa

```ts
// apps/api/src/modules/auth/guards/active-organization.guard.ts
const membership = await this.members.findActiveMembership(userId, organizationId);
if (membership === null) {
  throw new ForbiddenError('You are not a member of this organization');
}
this.context.setOrganization(membership.organizationId, membership.role);
```

La organización llega en la cabecera `X-Organization-Id`. Podría ir en el token,
y muchos productos lo hacen; aquí no, por dos motivos:

1. Cambiar de organización obligaría a reemitir tokens.
2. Peor: **el token seguiría afirmando una pertenencia que quizá se revocó hace
   diez minutos**. Consultando la base de datos, expulsar a alguien es inmediato.

La cabecera es una **pretensión**, no un permiso: dice para qué organización
quiere actuar el cliente, y el guard decide si puede. El resultado se escribe en
el contexto de la petición, y a partir de ahí los repositorios lo usan
(capítulo 10).

El mensaje de error es el mismo tanto si la organización no existe como si el
usuario no pertenece a ella. La diferencia confirmaría la existencia de un
tenant ajeno.

`@SkipOrganization()` marca lo que vive por encima del tenant: el perfil, la
lista de organizaciones y crear la primera. Sin esa excepción habría un problema
del huevo y la gallina.

## Guard 3 — roles

```ts
@Roles(OrganizationRole.organization_owner, OrganizationRole.organization_admin)
@Post('members')
invite(...) {}
```

El guard es deliberadamente tonto: compara el rol resuelto con la lista del
handler y nada más.

Lo que **no** hace es igual de importante. Las reglas que dependen del objeto
—"un tester puede editar su propio resultado, no el de otro"— no son
autorización de ruta: necesitan cargar el objeto, y por tanto viven en el
servicio. Meterlas en un guard obliga a consultar la base de datos dos veces y
dispersa la regla de negocio.

Y falla cerrado: si no hay rol resuelto, deniega.

```ts
it('rejects when no role was resolved', () => {
  const run = guardWithRole([OrganizationRole.viewer], undefined);
  expect(run).toThrow(ForbiddenError);
});
```

## Roles, no permisos granulares

Seis roles: `organization_owner`, `organization_admin`, `project_manager`,
`qa_lead`, `tester`, `viewer`. La matriz completa está en
[`../permissions-matrix.md`](../permissions-matrix.md).

Un sistema de permisos con recursos y acciones es más flexible y también mucha
más maquinaria de la que justifican seis roles y cero clientes. La ruta de
migración está pensada: el decorador `@Roles` se queda con el mismo nombre y
cambia lo que comprueba por dentro, así que los handlers no se tocan.

## Autorización en el backend, siempre

El frontend oculta botones. Eso es **experiencia de usuario, no seguridad**: la
API se puede llamar con `curl`. Cada endpoint decide por sí mismo, y las pruebas
de integración lo comprueban sin pasar por la interfaz.

## Errores comunes

- **Confiar en el frontend.** El error clásico y el más caro.
- **Poner la organización en el token.** Revocar una pertenencia deja de ser
  inmediato.
- **Aceptar `organizationId` del cuerpo de la petición.** El cliente nunca elige
  su tenant.
- **Guard opcional en vez de global.** Un endpoint nuevo sin decorador queda
  abierto.
- **Reglas sobre el objeto dentro de un guard.** Pertenecen al servicio.
- **Mensajes distintos** para "no existe" y "no puedes".

## Preguntas de repaso

1. ¿Por qué los guards son globales y no se aplican endpoint a endpoint?
2. ¿Por qué el orden de los `APP_GUARD` es significativo?
3. ¿Qué se perdería poniendo la organización activa en el JWT?
4. ¿Dónde va la regla "un tester solo edita sus propios resultados", y por qué
   no en un guard?

## Ejercicios

1. Crea un endpoint sin `@Public()` ni `@Roles` y comprueba con `curl` qué
   ocurre sin token, con token sin cabecera de organización y con ambos.
2. Escribe una prueba de integración en la que un `viewer` intente crear un
   proyecto y reciba `403`.
3. Diseña en papel el paso a permisos granulares manteniendo `@Roles` como API
   pública del decorador.

## Qué diría en una entrevista

> "Tres guards globales en un orden que importa: usuario, organización, rol.
> Globales para que autenticar sea el comportamiento por defecto y olvidar un
> decorador rompa un endpoint en vez de publicarlo. La organización activa va en
> una cabecera y se valida contra la tabla de miembros en cada petición, así que
> expulsar a alguien surte efecto al instante. Uso roles y no permisos
> granulares porque seis roles no justifican esa maquinaria, y las reglas que
> dependen del objeto están en el servicio, que es donde el objeto está
> cargado."

## MVP vs futuro

| Tema | MVP | Futuro |
| --- | --- | --- |
| Modelo | Seis roles fijos | Permisos por recurso y acción |
| Alcance | Por organización | Roles por proyecto sobre `ProjectMember` |
| Auditoría | Registro de acciones | Registro también de denegaciones |
| Delegación | No | Roles personalizados por cliente |

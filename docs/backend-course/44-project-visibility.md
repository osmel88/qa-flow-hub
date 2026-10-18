# 44 — Visibilidad por proyecto: que no se pueda descubrir lo que no se puede abrir

## Concepto

Hasta S3-F2 un grant decidía lo que un miembro podía **hacer** en un proyecto,
pero no lo que podía **ver**: cualquier miembro de la organización veía el
nombre de todos los proyectos. Si una organización aloja a dos clientes, eso ya
es una fuga.

La regla nueva (ADR 0017):

- `organization_owner` y `organization_admin` ven todos los proyectos.
- El resto de roles ve un proyecto solo si tiene una fila en `project_members`.
  Un grant con `role: null` da acceso con el rol de la organización.

Código de referencia:

- `apps/api/src/modules/projects/project-access.service.ts` — `seesEveryProject`,
  `visibleProjectIds`, `isVisible`, `effectiveRole`, `projectsAllowing`,
  `authorizeProjectScope`, `memberSees`.
- `apps/api/src/modules/projects/projects.repository.ts` — filtro `ids` en el listado.
- `apps/api/test/project-visibility.int-spec.ts` — las regresiones.
- `apps/web/src/app/query-client.ts` — refresco de la lista de proyectos tras un 404.

## Ocultar no es lo mismo que prohibir

Responder 403 a un proyecto oculto ya confirma que existe. La API responde a un
proyecto que no puedes ver **exactamente** igual que a un id inventado:

```ts
const grant = await this.grants.findGrant(projectId, userId);
if (grant === null && !seesEveryProject(organizationRole)) {
  throw new NotFoundError(resource); // "Requirement not found", igual que si no existiera
}
```

El nombre del recurso (`'Requirement'`, `'Test run'`…) se pasa desde el
servicio, porque `GET /requirements/:id` de un requisito inexistente responde
"Requirement not found", no "Project not found". Si el mensaje cambiara, el
mensaje sería el oráculo.

Los listados con `projectId` hacen lo mismo con la forma de la respuesta:
`authorizeProjectScope()` devuelve `null` tanto si el proyecto no existe como si
no es visible, y el servicio responde una página vacía.

## Los conteos también enumeran

Filtrar después de paginar deja `meta.total` contando proyectos ocultos. Por
eso el filtro va dentro de la consulta:

```ts
const visible = await this.access.visibleProjectIds(); // null = owner/admin
const page = await this.projects.list(query, {
  ...(visible === null ? {} : { ids: visible }),
  ...
});
```

Los agregados (`/dashboard`, `/dashboard/organization`) pasan por
`projectsAllowing()`, que descarta los proyectos sin grant antes de sumar.

## Fugas laterales

- **Trazabilidad:** un link puede unir un requisito visible con un caso de un
  proyecto oculto. El extremo oculto se omite y pedir el extremo oculto por id
  responde como un id inexistente.
- **Notificaciones:** asignar un defecto a alguien sin acceso le enviaría un
  correo con el nombre del proyecto. La asignación exige que el asignado vea el
  proyecto (`memberSees`).
- **Overrides:** no se pueden fijar para un miembro sin acceso (409); al revocar
  un grant se borran, para que volver a dar acceso empiece limpio.
- **Frontend:** al cambiar de organización se vacía toda la caché; un 404 en
  cualquier query invalida las listas de proyectos para que el selector no
  conserve un proyecto revocado.

## Por qué no RLS (todavía)

RLS sigue siendo la frontera de organización. Añadir el usuario a las políticas
obligaría a tocar todas las tablas y a hacer un sub-select en cada lectura. Es
una decisión consciente, registrada como deuda 39.

## Ejercicios

1. Añade un endpoint nuevo con `projectId` y comprueba que
   `project-visibility.int-spec.ts` lo detecta si olvidas `authorizeProjectScope`.
2. ¿Qué pasaría si `isVisible()` se resolviera desde el JWT? Piensa en la
   revocación inmediata.
3. Diseña la política RLS de la deuda 39 para `requirements` y mide el coste del
   sub-select con `EXPLAIN ANALYZE`.

import type { projectAccess as source } from '../en/projectAccess';

export const projectAccess: Partial<Record<keyof typeof source, string>> = {
  'projectAccess.youCannotChangeYourOwn': 'No puedes cambiar tu propio rol en un proyecto.',
  'projectAccess.anOrganizationOwnerKeepsFull':
    'Un owner de la organización conserva el acceso completo a todos los proyectos.',
  'projectAccess.yourRoleHereCannotChange':
    'Tu rol aquí ({value}) no puede cambiar a alguien que es {value2}.',
  'projectAccess.couldNotChangeTheRole': 'No se pudo cambiar el rol.',
  'projectAccess.couldNotRevokeTheRole': 'No se pudo revocar el rol.',
  'projectAccess.accessTo': 'Acceso a {value}',
  'projectAccess.ownersAndAdminsSeeEvery':
    'Los owners y admins ven todos los proyectos; el resto solo lo ve después de recibir acceso aquí. Un rol de proyecto sustituye al rol de la organización, pero solo dentro de este proyecto. Las excepciones conceden o revocan permisos sueltos encima de ese rol. Se muestre lo que se muestre aquí, la API comprueba las mismas reglas en cada llamada.',
  'projectAccess.effectiveRolesInThisProject': 'Roles efectivos en este proyecto',
  'projectAccess.member': 'Miembro',
  'projectAccess.inTheOrganization': 'En la organización',
  'projectAccess.inThisProject': 'En este proyecto',
  'projectAccess.enforced': 'Aplicado',
  'projectAccess.permissions': 'Permisos',
  'projectAccess.change': 'Cambiar',
  'projectAccess.noAccess': 'Sin acceso',
  'projectAccess.inherited': 'Heredado',
  'projectAccess.cannotSeeThisProject': 'No puede ver este proyecto',
  'projectAccess.thePermissionsOf': '{value} los permisos de {email}',
  'projectAccess.hide': 'Ocultar',
  'projectAccess.show': 'Mostrar',
  'projectAccess.setTheProjectRoleOf': 'Asignar el rol de proyecto de {email}',
  'projectAccess.choose': 'Elige…',
  'projectAccess.accessWithTheirOrganizationRole': 'Acceso con su rol de la organización',
  'projectAccess.revoke': 'Revocar',
  'projectAccess.removeAccess': 'Quitar acceso',
  'projectAccess.onlyManagersChangeRoles':
    'Solo los miembros que pueden gestionar el acceso aquí cambian los roles del proyecto.',
};

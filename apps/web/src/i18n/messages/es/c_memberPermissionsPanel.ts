import type { c_memberPermissionsPanel as source } from '../en/c_memberPermissionsPanel';

export const c_memberPermissionsPanel: Partial<Record<keyof typeof source, string>> = {
  'c_memberPermissionsPanel.couldNotSaveTheOverrides': 'No se pudieron guardar las excepciones.',
  'c_memberPermissionsPanel.loadingPermissions': 'Cargando permisos…',
  'c_memberPermissionsPanel.permissionsOfInThisProject': 'Permisos de {email} en este proyecto',
  'c_memberPermissionsPanel.organizationRole': 'Rol en la organización',
  'c_memberPermissionsPanel.projectRole': 'Rol en el proyecto',
  'c_memberPermissionsPanel.inherited': 'Heredado',
  'c_memberPermissionsPanel.enforcedRole': 'Rol aplicado',
  'c_memberPermissionsPanel.overrides': 'Excepciones',
  'c_memberPermissionsPanel.inThisProject': '{length} en este proyecto',
  'c_memberPermissionsPanel.noneTheRoleDecidesEverything': 'Ninguna: el rol lo decide todo.',
  'c_memberPermissionsPanel.anOrganizationOwnerHoldsEvery':
    'Un owner de la organización tiene todos los permisos en todos los proyectos. Las excepciones no le afectan.',
  'c_memberPermissionsPanel.overridesSavedTheApiApplies':
    'Excepciones guardadas. La API las aplica desde la siguiente petición.',
  'c_memberPermissionsPanel.permission': 'Permiso',
  'c_memberPermissionsPanel.held': 'Concedido',
  'c_memberPermissionsPanel.source': 'Origen',
  'c_memberPermissionsPanel.override': 'Excepción',
  'c_memberPermissionsPanel.allowed': 'Permitido',
  'c_memberPermissionsPanel.notAllowed': 'No permitido',
  'c_memberPermissionsPanel.overrideFor': 'Excepción de {permission} para {email}',
  'c_memberPermissionsPanel.roleDefault': 'Por defecto del rol',
  'c_memberPermissionsPanel.grant': 'Conceder',
  'c_memberPermissionsPanel.youDoNotHoldIt': ' (tú no lo tienes)',
  'c_memberPermissionsPanel.revoke': 'Revocar',
  'c_memberPermissionsPanel.saving': 'Guardando…',
  'c_memberPermissionsPanel.saveOverrides': 'Guardar excepciones',
  'c_memberPermissionsPanel.discard': 'Descartar',
};

import type { integrations as source } from '../en/integrations';

export const integrations: Partial<Record<keyof typeof source, string>> = {
  'integrations.configurationSaved': 'Configuración guardada.',
  'integrations.couldNotSaveTheConfiguration': 'No se pudo guardar la configuración.',
  'integrations.enabledWaitingForAProvider':
    'Activada, a la espera de una implementación del proveedor.',
  'integrations.connected': 'Conectado.',
  'integrations.couldNotConnect': 'No se pudo conectar.',
  'integrations.disconnectedTheConfigurationAndIts':
    'Desconectado. Se conservaron la configuración y sus referencias.',
  'integrations.couldNotDisconnect': 'No se pudo desconectar.',
  'integrations.couldNotTestTheConnection': 'No se pudo probar la conexión.',
  'integrations.mock': 'Mock',
  'integrations.real': 'Real',
  'integrations.enabled': 'Activada',
  'integrations.disabled': 'Desactivada',
  'integrations.lastSynchronised': 'Última sincronización',
  'integrations.lastConnectionTest': 'Última prueba de conexión',
  'integrations.credential': 'Credencial',
  'integrations.stored': 'Guardada',
  'integrations.none': 'Ninguna',
  'integrations.mode': 'Modo',
  'integrations.whichSideOfTheProvider': 'Con qué lado del proveedor habla esta organización.',
  'integrations.baseUrl': 'URL base',
  'integrations.absoluteHttpSUrlOf': 'URL http(s) absoluta de la instancia del proveedor.',
  'integrations.configuration': 'Configuración',
  'integrations.oneKeyValuePairPer':
    'Un par clave=valor por línea. Aquí no se aceptan credenciales.',
  'integrations.save': 'Guardar',
  'integrations.testConnection': 'Probar conexión',
  'integrations.disconnect': 'Desconectar',
  'integrations.connect': 'Conectar',
  'integrations.saveTheConfigurationBeforeConnecting': 'Guarda la configuración antes de conectar.',
  'integrations.integrations': 'Integraciones',
  'integrations.perOrganizationConfigurationOfJira':
    'Configuración por organización de Jira, TestRail y GitHub. Las credenciales nunca se muestran y no se acepta ningún token hasta que exista el almacén cifrado de credenciales.',
  'integrations.onlyOrganizationOwnersAndAdmins':
    'Solo los owners y admins de la organización pueden cambiar estos ajustes. Puedes ver cómo están configurados.',
  'integrations.useOneKeyValuePerLine': 'Usa un par clave=valor por línea.',
};

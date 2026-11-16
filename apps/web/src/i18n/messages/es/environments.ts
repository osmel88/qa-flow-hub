import type { environments as source } from '../en/environments';

export const environments: Partial<Record<keyof typeof source, string>> = {
  'environments.protected': 'protegido',
  'environments.couldNotCreateTheEnvironment': 'No se pudo crear el entorno.',
  'environments.environments': 'Entornos',
  'environments.whereTheProjectIsDeployed':
    'Dónde se despliega el proyecto, qué se ejecuta ahí y cómo va.',
  'environments.environmentFilters': 'Filtros de entornos',
  'environments.searchEnvironments': 'Buscar entornos',
  'environments.environmentStatus': 'Estado del entorno',
  'environments.activeAndInactive': 'Activos e inactivos',
  'environments.environmentType': 'Tipo de entorno',
  'environments.anyType': 'Cualquier tipo',
  'environments.environmentHealth': 'Salud del entorno',
  'environments.anyHealth': 'Cualquier salud',
  'environments.addAnEnvironment': 'Añadir un entorno',
  'environments.environmentName': 'Nombre del entorno',
  'environments.environmentKind': 'Tipo de entorno',
  'environments.environmentDescription': 'Descripción del entorno',
  'environments.environmentUrl': 'URL del entorno',
  'environments.productionEnvironmentsStartProtected':
    'Los entornos de producción empiezan protegidos.',
  'environments.addEnvironment': 'Añadir entorno',
  'environments.noEnvironmentsMatch': 'Ningún entorno coincide.',
  'environments.environment': 'Entorno',
  'environments.health': 'Salud',
  'environments.running': 'En ejecución',
  'environments.release': 'Release',
  'environments.deployments': 'Despliegues',
  'environments.nothingDeployed': 'nada desplegado',
  'environments.none': 'ninguno',
};

import type { qualityGates as source } from '../en/qualityGates';

export const qualityGates: Partial<Record<keyof typeof source, string>> = {
  'qualityGates.couldNotSaveTheQuality': 'No se pudo guardar el quality gate.',
  'qualityGates.qualityGates': 'Quality gates',
  'qualityGates.rulesAReleaseMustMeet':
    'Reglas que debe cumplir una release; los gates obligatorios protegen los entornos protegidos.',
  'qualityGates.addAQualityGate': 'Añadir un quality gate',
  'qualityGates.gateName': 'Nombre del gate',
  'qualityGates.gateEnvironment': 'Entorno del gate',
  'qualityGates.everyEnvironment': 'Todos los entornos',
  'qualityGates.requiredBlocksProtectedEnvironments':
    'Obligatorio (bloquea los entornos protegidos)',
  'qualityGates.rules': 'Reglas',
  'qualityGates.threshold': 'Umbral de {value}',
  'qualityGates.addQualityGate': 'Añadir quality gate',
  'qualityGates.noQualityGateYet': 'Todavía no hay quality gates.',
  'qualityGates.everyEnvironment2': 'todos los entornos',
  'qualityGates.required': 'obligatorio',
  'qualityGates.advisory': 'orientativo',
  'qualityGates.disabled': 'desactivado',
  'qualityGates.disable': 'Desactivar',
  'qualityGates.enable': 'Activar',
  'qualityGates.delete': 'Eliminar',
};

import type { qualityGates as source } from '../en/qualityGates';

export const qualityGates: Partial<Record<keyof typeof source, string>> = {
  'qualityGates.couldNotSaveTheQuality': 'No se pudo guardar la puerta de calidad.',
  'qualityGates.qualityGates': 'Puertas de calidad',
  'qualityGates.rulesAReleaseMustMeet':
    'Reglas que debe cumplir una release; los gates obligatorios protegen los entornos protegidos.',
  'qualityGates.addAQualityGate': 'Añadir una puerta de calidad',
  'qualityGates.gateName': 'Nombre del gate',
  'qualityGates.gateEnvironment': 'Entorno del gate',
  'qualityGates.everyEnvironment': 'Todos los entornos',
  'qualityGates.requiredBlocksProtectedEnvironments':
    'Obligatorio (bloquea los entornos protegidos)',
  'qualityGates.rules': 'Reglas',
  'qualityGates.threshold': 'Umbral de {value}',
  'qualityGates.addQualityGate': 'Añadir puerta de calidad',
  'qualityGates.noQualityGateYet': 'Todavía no hay puertas de calidad.',
  'qualityGates.everyEnvironment2': 'todos los entornos',
  'qualityGates.required': 'obligatorio',
  'qualityGates.advisory': 'orientativo',
  'qualityGates.disabled': 'desactivado',
  'qualityGates.disable': 'Desactivar',
  'qualityGates.enable': 'Activar',
  'qualityGates.delete': 'Eliminar',
};

import type { printableMatrix as source } from '../en/printableMatrix';

export const printableMatrix: Partial<Record<keyof typeof source, string>> = {
  'printableMatrix.traceabilityMatrix': 'Matriz de trazabilidad —',
  'printableMatrix.generated': 'Generada',
  'printableMatrix.of': 'de',
  'printableMatrix.requirementsCovered': 'requisitos cubiertos (',
  'printableMatrix.verified': 'verificados,',
  'printableMatrix.openDefects': 'defectos abiertos.',
  'printableMatrix.traceabilityMatrix2': 'Matriz de trazabilidad',
  'printableMatrix.requirement': 'Requisito',
  'printableMatrix.cases': 'Casos',
  'printableMatrix.covered': 'Cubierto',
  'printableMatrix.verified2': 'Verificado',
  'printableMatrix.openDefects2': 'Defectos abiertos',
  'printableMatrix.none': 'Ninguno',
  'printableMatrix.yes': 'Sí',
  'printableMatrix.no': 'No',
  'printableMatrix.printSaveAsPdf': 'Imprimir / Guardar como PDF',
};

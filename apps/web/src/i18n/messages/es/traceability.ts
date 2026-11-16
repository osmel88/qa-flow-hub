import type { traceability as source } from '../en/traceability';

export const traceability: Partial<Record<keyof typeof source, string>> = {
  'traceability.traceability': 'Trazabilidad',
  'traceability.everyRequirementTheCasesThat':
    'Cada requisito, los casos que lo verifican y los defectos asociados.',
  'traceability.exportCsv': 'Exportar CSV',
  'traceability.printableView': 'Vista para imprimir',
  'traceability.showOnlyRequirementsWithNo': 'Mostrar solo requisitos sin casos de prueba',
  'traceability.of': 'de',
  'traceability.covered': 'cubiertos (',
  'traceability.verified': 'verificados,',
  'traceability.openDefects': 'defectos abiertos.',
  'traceability.nothingToTraceYetAdd':
    'Todavía no hay nada que trazar. Añade requisitos y vincula casos a ellos.',
  'traceability.requirement': 'Requisito',
  'traceability.workItems': 'Work items',
  'traceability.cases': 'Casos',
  'traceability.covered2': 'Cubierto',
  'traceability.verified2': 'Verificado',
  'traceability.defects': 'Defectos',
  'traceability.none': 'Ninguno',
  'traceability.archived': 'Archivado',
  'traceability.yes': 'Sí',
  'traceability.no': 'No',
};

import type { hierarchy as source } from '../en/hierarchy';

export const hierarchy: Partial<Record<keyof typeof source, string>> = {
  'hierarchy.doneEstimated': '{done}/{countable} terminados{progress} · {estimate} estimados',
  'hierarchy.couldNotMoveTheWork': 'No se pudo mover el elemento de trabajo.',
  'hierarchy.moveUnder': 'Mover {key} bajo',
  'hierarchy.topLevel': 'Nivel superior',
  'hierarchy.hierarchy': 'Jerarquía',
  'hierarchy.epicsFeaturesStoriesAndTasks':
    'Épicas, features, historias y tareas en árbol, con el progreso y las estimaciones de todo lo que hay debajo de cada elemento.',
  'hierarchy.hierarchyFilters': 'Filtros de la jerarquía',
  'hierarchy.developmentFilter': 'Filtro de desarrollo',
  'hierarchy.typeFilter': 'Filtro de tipo',
  'hierarchy.anyType': 'Cualquier tipo',
  'hierarchy.statusFilter': 'Filtro de estado',
  'hierarchy.anyStatus': 'Cualquier estado',
  'hierarchy.searchTree': 'Buscar en el árbol',
  'hierarchy.expandAll': 'Expandir todo',
  'hierarchy.collapseAll': 'Contraer todo',
  'hierarchy.items': 'elementos ·',
  'hierarchy.done': 'terminados ·',
  'hierarchy.estimated': 'estimados',
  'hierarchy.noWorkItemMatches': 'Ningún elemento de trabajo coincide.',
  'hierarchy.workItemHierarchy': 'Jerarquía de elementos de trabajo',
  'hierarchy.collapseItem': 'Contraer {key}',
  'hierarchy.expandItem': 'Expandir {key}',
  'hierarchy.showingTheFirst2000': ' · se muestran los primeros 2000',
};

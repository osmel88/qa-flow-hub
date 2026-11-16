import type { workItems as source } from '../en/workItems';

export const workItems: Partial<Record<keyof typeof source, string>> = {
  'workItems.couldNotCreateTheWork': 'No se pudo crear el work item.',
  'workItems.workItems': 'Work items',
  'workItems.theProjectBacklogEpicsFeatures':
    'El backlog del proyecto: épicas, features, historias, tareas, bugs, mejoras y spikes.',
  'workItems.newWorkItem': 'Nuevo work item',
  'workItems.title': 'Título',
  'workItems.type': 'Tipo',
  'workItems.priority': 'Prioridad',
  'workItems.estimate': 'Estimación',
  'workItems.labels': 'Etiquetas',
  'workItems.commaSeparated': 'Separadas por comas',
  'workItems.addWorkItem': 'Añadir work item',
  'workItems.filters': 'Filtros',
  'workItems.filterByType': 'Filtrar por tipo',
  'workItems.anyType': 'Cualquier tipo',
  'workItems.filterByStatus': 'Filtrar por estado',
  'workItems.anyStatus': 'Cualquier estado',
  'workItems.search': 'Buscar',
  'workItems.noWorkItemMatches': 'Ningún work item coincide.',
  'workItems.key': 'Clave',
  'workItems.status': 'Estado',
  'workItems.none': 'Ninguno',
};

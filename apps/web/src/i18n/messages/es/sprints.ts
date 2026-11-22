import type { sprints as source } from '../en/sprints';

export const sprints: Partial<Record<keyof typeof source, string>> = {
  'sprints.couldNotCreateTheSprint': 'No se pudo crear el sprint.',
  'sprints.sprints': 'Sprints',
  'sprints.timeBoxesOfTheBacklog':
    'Periodos de tiempo del backlog. Cada proyecto tiene un solo sprint activo a la vez; los sprints completados y cancelados se conservan como histórico.',
  'sprints.newSprint': 'Nuevo sprint',
  'sprints.sprintName': 'Nombre del sprint',
  'sprints.goal': 'Objetivo',
  'sprints.startDate': 'Fecha de inicio',
  'sprints.endDate': 'Fecha de fin',
  'sprints.capacityPoints': 'Capacidad (puntos)',
  'sprints.createSprint': 'Crear sprint',
  'sprints.velocity': 'Velocidad',
  'sprints.pointsPerSprintAverageOf': 'puntos por sprint, media de los últimos',
  'sprints.completedSprintS':
    '{count, plural, one {# sprint completado.} other {# sprints completados.}}',
  'sprints.statusFilter': 'Filtro de estado',
  'sprints.anyStatus': 'Cualquier estado',
  'sprints.noSprintYet': 'Todavía no hay sprints.',
  'sprints.sprint': 'Sprint',
  'sprints.status': 'Estado',
  'sprints.dates': 'Fechas',
  'sprints.capacity': 'Capacidad',
  'sprints.committed': 'Comprometido',
  'sprints.completed': 'Completado',
};

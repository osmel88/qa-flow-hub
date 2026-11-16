import type { testRuns as source } from '../en/testRuns';

export const testRuns: Partial<Record<keyof typeof source, string>> = {
  'testRuns.couldNotCreateTheRun': 'No se pudo crear la ejecución.',
  'testRuns.testRuns': 'Ejecuciones de prueba',
  'testRuns.aRunFreezesTheCases':
    'Una ejecución congela los casos que contiene, así que editar un caso después nunca reescribe la historia.',
  'testRuns.newRun': 'Nueva ejecución',
  'testRuns.name': 'Nombre',
  'testRuns.casesFromSuite': 'Casos de la suite',
  'testRuns.everyCaseInTheProject': 'Todos los casos del proyecto',
  'testRuns.release': 'Release',
  'testRuns.noRelease': 'Sin release',
  'testRuns.createRun': 'Crear ejecución',
  'testRuns.filterByRelease': 'Filtrar por release',
  'testRuns.allRuns': 'Todas las ejecuciones',
  'testRuns.noRunYetCreateOne': 'Todavía no hay ejecuciones. Crea una para empezar a ejecutar.',
  'testRuns.run': 'Ejecución',
  'testRuns.status': 'Estado',
  'testRuns.cases': 'Casos',
  'testRuns.progress': 'Progreso',
  'testRuns.testrail': 'TestRail',
  'testRuns.github': 'GitHub',
};

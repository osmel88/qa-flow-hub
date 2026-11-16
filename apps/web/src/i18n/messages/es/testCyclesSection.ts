import type { testCyclesSection as source } from '../en/testCyclesSection';

export const testCyclesSection: Partial<Record<keyof typeof source, string>> = {
  'testCyclesSection.couldNotCreateTheCycle': 'No se pudo crear el ciclo.',
  'testCyclesSection.cycles': 'Ciclos',
  'testCyclesSection.noCycleYet': 'Todavía no hay ciclos.',
  'testCyclesSection.planCycles': 'Ciclos del plan',
  'testCyclesSection.cycle': 'Ciclo',
  'testCyclesSection.status': 'Estado',
  'testCyclesSection.environment': 'Entorno',
  'testCyclesSection.release': 'Release',
  'testCyclesSection.cases': 'Casos',
  'testCyclesSection.any': 'cualquiera',
  'testCyclesSection.none': 'ninguna',
  'testCyclesSection.newCycle': 'Nuevo ciclo',
  'testCyclesSection.cycleName': 'Nombre del ciclo',
  'testCyclesSection.cycleEnvironment': 'Entorno del ciclo',
  'testCyclesSection.anyEnvironment': 'Cualquier entorno',
  'testCyclesSection.createCycle': 'Crear ciclo',
  'testCyclesSection.frozenFromPlan': ' (congelado desde el plan v{version})',
};

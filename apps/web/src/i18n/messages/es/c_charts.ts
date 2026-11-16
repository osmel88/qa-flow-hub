import type { c_charts as source } from '../en/c_charts';

export const c_charts: Partial<Record<keyof typeof source, string>> = {
  'c_charts.noRunCaseInThis': 'No hay casos ejecutados en este periodo.',
  'c_charts.status': 'Estado',
  'c_charts.cases': 'Casos',
  'c_charts.rate': 'Tasa',
  'c_charts.passFailedAndBlockedRates':
    'Las tasas de passed, failed y blocked se calculan sobre veredictos (',
  'c_charts.skippedAndUntestedAreOver': '); skipped y untested, sobre casos planificados (',
  'c_charts.noData': '{label}: sin datos',
  'c_charts.fromTo': '{label}: de {value}{suffix} a {value2}{suffix2}',
  'c_charts.showDataTable': 'Mostrar tabla de datos',
  'c_charts.bucket': 'Intervalo',
  'c_charts.nothingToCompareYet': 'Todavía no hay nada que comparar.',
};

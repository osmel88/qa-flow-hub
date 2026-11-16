import type { printableRun as source } from '../en/printableRun';

export const printableRun: Partial<Record<keyof typeof source, string>> = {
  'printableRun.testRun': 'Ejecución de pruebas —',
  'printableRun.generated': '· Generada',
  'printableRun.of': 'de',
  'printableRun.executed': 'ejecutados (',
  'printableRun.passed': 'passed,',
  'printableRun.failed': 'failed,',
  'printableRun.blocked': 'blocked,',
  'printableRun.skipped': 'skipped.',
  'printableRun.runCases': 'Casos de la ejecución',
  'printableRun.key': 'Clave',
  'printableRun.title': 'Título',
  'printableRun.priority': 'Prioridad',
  'printableRun.version': 'Versión',
  'printableRun.status': 'Estado',
};

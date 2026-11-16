import type { c_qualityGateResults as source } from '../en/c_qualityGateResults';

export const c_qualityGateResults: Partial<Record<keyof typeof source, string>> = {
  'c_qualityGateResults.noQualityGateAppliesHere': 'Aquí no se aplica ningún quality gate.',
  'c_qualityGateResults.qualityGateResults': 'Resultados de los quality gates',
  'c_qualityGateResults.required': 'obligatorio',
  'c_qualityGateResults.advisory': 'orientativo',
};

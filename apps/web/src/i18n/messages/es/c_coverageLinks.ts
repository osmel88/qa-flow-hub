import type { c_coverageLinks as source } from '../en/c_coverageLinks';

export const c_coverageLinks: Partial<Record<keyof typeof source, string>> = {
  'c_coverageLinks.couldNotCreateTheLink': 'No se pudo crear el vínculo.',
  'c_coverageLinks.couldNotRemoveTheLink': 'No se pudo quitar el vínculo.',
  'c_coverageLinks.traceabilityLinks': 'Vínculos de trazabilidad',
  'c_coverageLinks.verifiedBy': 'Verificado por',
  'c_coverageLinks.verifies': 'Verifica',
  'c_coverageLinks.noTestCaseVerifiesThis':
    'Todavía ningún caso de prueba verifica este requisito.',
  'c_coverageLinks.thisCaseIsNotLinked': 'Este caso todavía no está vinculado a ningún requisito.',
  'c_coverageLinks.unlink': 'Desvincular',
  'c_coverageLinks.linkATestCase': 'Vincular un caso de prueba',
  'c_coverageLinks.linkARequirement': 'Vincular un requisito',
  'c_coverageLinks.choose': 'Elige…',
  'c_coverageLinks.link': 'Vincular',
};

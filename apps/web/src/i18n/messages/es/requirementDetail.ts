import type { requirementDetail as source } from '../en/requirementDetail';

export const requirementDetail: Partial<Record<keyof typeof source, string>> = {
  'requirementDetail.requirementDetailAndTheWork':
    'Detalle del requisito y los elementos de trabajo que lo implementan.',
  'requirementDetail.allRequirements': '← Todos los requisitos',
  'requirementDetail.summary': 'Resumen',
  'requirementDetail.couldNotUpdateTheLink': 'No se pudo actualizar el vínculo.',
  'requirementDetail.implementedBy': 'Implementado por',
  'requirementDetail.noWorkItemImplementsThis':
    'Todavía ningún elemento de trabajo implementa este requisito.',
  'requirementDetail.unlink': 'Desvincular {key}',
  'requirementDetail.unlink2': 'Desvincular',
  'requirementDetail.linkWorkItem': 'Vincular elemento de trabajo',
  'requirementDetail.chooseAWorkItem': 'Elige un elemento de trabajo…',
  'requirementDetail.link': 'Vincular',
};

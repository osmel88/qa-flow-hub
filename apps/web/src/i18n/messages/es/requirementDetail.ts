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
  'requirementDetail.acceptanceCriteria': 'Criterios de aceptación',
  'requirementDetail.manage': 'Edición y estado',
  'requirementDetail.changeStatus': 'Cambiar estado',
  'requirementDetail.retire': 'Retirar (marcar como obsoleto)',
  'requirementDetail.retireHint':
    'Conserva su histórico, cobertura y versiones; más adelante puedes devolverlo a otro estado.',
  'requirementDetail.chooseAStatus': 'Elige un estado…',
  'requirementDetail.title': 'Título',
  'requirementDetail.titleTooShort': 'El título necesita al menos 3 caracteres.',
  'requirementDetail.description': 'Descripción',
  'requirementDetail.type': 'Tipo',
  'requirementDetail.priority': 'Prioridad',
  'requirementDetail.save': 'Guardar cambios',
  'requirementDetail.cancel': 'Cancelar',
  'requirementDetail.edit': 'Editar requisito',
  'requirementDetail.delete': 'Eliminar requisito',
  'requirementDetail.confirmDelete':
    '¿Eliminar {key}? Se quitan sus vínculos con casos de prueba y elementos de trabajo.',
  'requirementDetail.confirmDeleteButton': 'Sí, eliminar',
  'requirementDetail.deleteExplanation':
    'Cada edición guarda una versión en el historial. Eliminar es un borrado lógico: el requisito y su historial se conservan para auditoría, pero desaparece de listas, cobertura y trazabilidad. Para retirar un requisito que sigue importando para el histórico, pásalo a obsoleto.',
  'requirementDetail.couldNotSave': 'No se pudo guardar el requisito.',
  'requirementDetail.couldNotChangeTheStatus': 'No se pudo cambiar el estado.',
  'requirementDetail.couldNotDelete': 'No se pudo eliminar el requisito.',
};

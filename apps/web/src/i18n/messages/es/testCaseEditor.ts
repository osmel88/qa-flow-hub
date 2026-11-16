import type { testCaseEditor as source } from '../en/testCaseEditor';

export const testCaseEditor: Partial<Record<keyof typeof source, string>> = {
  'testCaseEditor.couldNotSaveTheCase': 'No se pudo guardar el caso.',
  'testCaseEditor.testCase': 'Caso de prueba',
  'testCaseEditor.editor': '{key} — editor',
  'testCaseEditor.savingAContentChangeCreates':
    'Guardar un cambio de contenido crea una versión nueva; las ejecuciones ya creadas conservan la versión que ejecutaron.',
  'testCaseEditor.backToCases': 'Volver a los casos',
  'testCaseEditor.savedAsVersion': 'Guardado como versión',
  'testCaseEditor.title': 'Título',
  'testCaseEditor.steps': 'Pasos',
  'testCaseEditor.noStepsYetAddThe': 'Todavía no hay pasos. Añade el primero.',
  'testCaseEditor.stepAction': 'Acción del paso {value}',
  'testCaseEditor.stepExpectedResult': 'Resultado esperado del paso {value}',
  'testCaseEditor.removeStep': 'Quitar paso',
  'testCaseEditor.changeReasonOptional': 'Motivo del cambio (opcional)',
  'testCaseEditor.addStep': 'Añadir paso',
  'testCaseEditor.saveCase': 'Guardar caso',
  'testCaseEditor.aCaseIsCappedAt': 'Un caso admite como máximo',
  'testCaseEditor.steps2': 'pasos.',
};

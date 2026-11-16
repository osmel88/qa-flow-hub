import type { testCaseParameters as source } from '../en/testCaseParameters';

export const testCaseParameters: Partial<Record<keyof typeof source, string>> = {
  'testCaseParameters.theDefaultOf': 'El valor por defecto de {value} {error}',
  'testCaseParameters.row': 'Fila {value}: {name} {error}',
  'testCaseParameters.couldNotSaveTheDataset': 'No se pudo guardar el dataset.',
  'testCaseParameters.parametersSaved': 'Parámetros guardados',
  'testCaseParameters.datasetImported': 'Dataset importado',
  'testCaseParameters.parametersAndDataset': 'Parámetros y dataset',
  'testCaseParameters.aRunExecutesThisCase':
    'Una ejecución ejecuta este caso una vez por fila del dataset y conserva los valores que usó.',
  'testCaseParameters.noParametersTheCaseRuns': 'Sin parámetros: el caso se ejecuta una vez.',
  'testCaseParameters.parameterName': 'Nombre del parámetro {value}',
  'testCaseParameters.parameterType': 'Tipo del parámetro {value}',
  'testCaseParameters.parameterRequired': 'Parámetro {value} obligatorio',
  'testCaseParameters.parameterDefault': 'Valor por defecto del parámetro {value}',
  'testCaseParameters.removeParameter': 'Quitar parámetro',
  'testCaseParameters.dataset': 'Dataset',
  'testCaseParameters.row2': 'Fila',
  'testCaseParameters.rowLabel': 'Etiqueta de la fila {value}',
  'testCaseParameters.row3': 'Fila {value} {name}',
  'testCaseParameters.removeRow': 'Quitar fila',
  'testCaseParameters.addParameter': 'Añadir parámetro',
  'testCaseParameters.addRow': 'Añadir fila',
  'testCaseParameters.saveParameters': 'Guardar parámetros',
  'testCaseParameters.exportDatasetCsv': 'Exportar dataset CSV',
  'testCaseParameters.importDatasetCsv': 'Importar dataset CSV',
  'testCaseParameters.savedAsVersion': '{what} como versión {version}.',
};

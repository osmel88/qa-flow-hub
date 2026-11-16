import type { noProject as source } from '../en/noProject';

export const noProject: Partial<Record<keyof typeof source, string>> = {
  'noProject.thisScreenWorksInsideA':
    'Esta pantalla funciona dentro de un proyecto y todavía no hay ninguno seleccionado.',
  'noProject.createAProject': 'Crear un proyecto',
};

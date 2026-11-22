import type { projects as source } from '../en/projects';

export const projects: Partial<Record<keyof typeof source, string>> = {
  'projects.couldNotCreateTheProject': 'No se pudo crear el proyecto.',
  'projects.projects': 'Proyectos',
  'projects.aProjectOwnsItsOwn':
    'Cada proyecto tiene su propia secuencia de claves: WEB-R-1, WEB-C-1, WEB-D-1.',
  'projects.newProject': 'Nuevo proyecto',
  'projects.name': 'Nombre',
  'projects.key': 'Clave',
  'projects.itPrefixesEveryReadableId':
    '{rule} Es el prefijo de todos los identificadores legibles y no se puede cambiar.',
  'projects.createProject': 'Crear proyecto',
  'projects.noProjectsYetCreateThe': 'Todavía no hay proyectos. Crea el primero arriba.',
  'projects.projectsInThisOrganization': 'Proyectos de esta organización',
  'projects.status': 'Estado',
  'projects.actions': 'Acciones',
  'projects.restore': 'Restaurar',
  'projects.archive': 'Archivar',
  'projects.keyRule': 'De 2 a 8 letras mayúsculas o dígitos, empezando por una letra.',
  'projects.roleCannotCreate':
    'Tu rol no permite crear proyectos en esta organización. Pueden crearlos los propietarios y administradores de la organización.',
  'projects.noDeleteExplanation':
    'Los proyectos se archivan, no se eliminan: eliminar uno borraría sus requisitos, casos de prueba, ejecuciones, defectos, releases e histórico de QA. Un proyecto archivado es de solo lectura y se puede restaurar.',
  'projects.description': 'Descripción',
  'projects.save': 'Guardar',
  'projects.cancel': 'Cancelar',
  'projects.open': 'Abrir',
  'projects.openProject': 'Abrir {key}',
  'projects.edit': 'Editar',
  'projects.editProject': 'Editar {key}',
  'projects.confirmArchive': '¿Archivar {key}? Quedará en solo lectura hasta que se restaure.',
  'projects.confirmArchiveButton': 'Sí, archivar',
  'projects.couldNotSaveTheProject': 'No se pudo guardar el proyecto.',
  'projects.couldNotChangeTheProject': 'No se pudo cambiar el proyecto.',
};

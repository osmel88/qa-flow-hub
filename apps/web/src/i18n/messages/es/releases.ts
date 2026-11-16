import type { releases as source } from '../en/releases';

export const releases: Partial<Record<keyof typeof source, string>> = {
  'releases.couldNotCreateTheRelease': 'No se pudo crear la release.',
  'releases.releases': 'Releases',
  'releases.aReleaseGroupsTheRuns':
    'Una release agrupa las ejecuciones que deciden si una versión se puede publicar. Al archivarla se conservan todas las ejecuciones y resultados.',
  'releases.newRelease': 'Nueva release',
  'releases.releaseName': 'Nombre de la release',
  'releases.version': 'Versión',
  'releases.tagOptional': 'Tag (opcional)',
  'releases.startDate': 'Fecha de inicio',
  'releases.targetDate': 'Fecha objetivo',
  'releases.createRelease': 'Crear release',
  'releases.status': 'Estado',
  'releases.anyStatus': 'Cualquier estado',
  'releases.noReleaseYet': 'Todavía no hay releases.',
  'releases.release': 'Release',
  'releases.runs': 'Ejecuciones',
};

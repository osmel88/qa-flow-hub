import type { c_attachmentsPanel as source } from '../en/c_attachmentsPanel';

export const c_attachmentsPanel: Partial<Record<keyof typeof source, string>> = {
  'c_attachmentsPanel.couldNotDeleteTheFile': 'No se pudo eliminar el fichero.',
  'c_attachmentsPanel.couldNotDownloadTheFile': 'No se pudo descargar el fichero.',
  'c_attachmentsPanel.couldNotOpenTheFile': 'No se pudo abrir el fichero.',
  'c_attachmentsPanel.unsupportedFileTypeAllowed':
    'Tipo de fichero no admitido. Permitidos: {value}.',
  'c_attachmentsPanel.fileTooLargeExceedsThe':
    'Fichero demasiado grande: {value} supera el límite de {value2}.',
  'c_attachmentsPanel.chooseAFileFor': 'Elige un fichero para {value}',
  'c_attachmentsPanel.uploading': 'Subiendo…',
  'c_attachmentsPanel.imagesTxtLogJsonOr': 'Imágenes, .txt/.log, .json o .pdf de hasta',
  'c_attachmentsPanel.noEvidenceAttachedYet': 'Todavía no hay evidencias adjuntas.',
  'c_attachmentsPanel.preview': 'Vista previa',
  'c_attachmentsPanel.open': 'Abrir',
  'c_attachmentsPanel.download': 'Descargar',
  'c_attachmentsPanel.delete': 'Eliminar',
  'c_attachmentsPanel.closePreview': 'Cerrar vista previa',
  'c_attachmentsPanel.couldNotUploadTheFile': 'No se pudo subir el fichero.',
  'c_attachmentsPanel.unsupportedFileType': 'Tipo de fichero no admitido: {message}',
  'c_attachmentsPanel.fileTooLarge': 'Fichero demasiado grande: {message}',
  'c_attachmentsPanel.nothingExistingWasRemovedSee':
    '{message}. No se eliminó nada existente; consulta Facturación para mejorar el plan.',
  'c_attachmentsPanel.storageIsUnavailableRightNow':
    'El almacenamiento no está disponible ahora mismo. Inténtalo de nuevo en un momento.',
  'c_attachmentsPanel.kib': '{value} KiB',
  'c_attachmentsPanel.mib': '{value} MiB',
  'c_attachmentsPanel.evidence': 'Evidencias',
};

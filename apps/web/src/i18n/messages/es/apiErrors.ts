import type { apiErrors as source } from '../en/apiErrors';

export const apiErrors: Partial<Record<keyof typeof source, string>> = {
  'apiError.UNAUTHENTICATED': 'Tu sesión ha terminado. Vuelve a iniciar sesión.',
  'apiError.INVALID_CREDENTIALS': 'El correo electrónico o la contraseña no son correctos.',
  'apiError.TOKEN_EXPIRED': 'Este enlace o sesión ha caducado.',
  'apiError.ACCOUNT_LOCKED': 'La cuenta está bloqueada temporalmente. Inténtalo más tarde.',
  'apiError.FORBIDDEN': 'Tu rol no permite realizar esta acción.',
  'apiError.MFA_INVALID_CODE': 'El código de verificación no es válido.',
  'apiError.NOT_FOUND': 'El recurso no existe o no tienes acceso a él.',
  'apiError.CONFLICT':
    'La acción entra en conflicto con el estado actual. Recarga e inténtalo de nuevo.',
  'apiError.DUPLICATE_RESOURCE': 'Ya existe un recurso con esos valores.',
  'apiError.INVALID_STATE_TRANSITION': 'Esta acción no es posible en el estado actual.',
  'apiError.VALIDATION_ERROR':
    'Algunos valores no son válidos. Revisa el formulario e inténtalo de nuevo.',
  'apiError.QUALITY_GATE_FAILED': 'Una puerta de calidad no se ha superado.',
  'apiError.APPROVAL_REQUIRED': 'Esta acción necesita antes una aprobación.',
  'apiError.RATE_LIMITED': 'Demasiadas peticiones. Espera un momento e inténtalo de nuevo.',
  'apiError.PLAN_LIMIT_REACHED': 'Has alcanzado el límite de tu plan.',
  'apiError.INTEGRATION_NOT_CONFIGURED': 'Esta integración no está configurada.',
  'apiError.INTEGRATION_ERROR': 'La integración externa no respondió como se esperaba.',
  'apiError.UNSUPPORTED_FILE_TYPE': 'Este tipo de archivo no está admitido.',
  'apiError.FILE_TOO_LARGE': 'El archivo es demasiado grande.',
  'apiError.STORAGE_ERROR': 'No se pudo guardar el archivo. Inténtalo de nuevo.',
  'apiError.IMPORT_STALE': 'Los datos cambiaron desde la simulación. Vuelve a ejecutarla.',
  'apiError.IMPORT_TOO_LARGE': 'La importación es demasiado grande.',
  'apiError.EXPORT_TOO_LARGE': 'La exportación es demasiado grande. Acota los datos.',
  'apiError.NOT_IMPLEMENTED': 'Esta acción todavía no está disponible.',
  'apiError.INTERNAL_ERROR': 'Algo salió mal en el servidor. Inténtalo de nuevo.',
  'apiError.unknown': 'No se pudo completar la acción. Inténtalo de nuevo.',
};

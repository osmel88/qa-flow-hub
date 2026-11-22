import type { c_mfaSettings as source } from '../en/c_mfaSettings';

export const c_mfaSettings: Partial<Record<keyof typeof source, string>> = {
  'c_mfaSettings.saveTheseRecoveryCodesSomewhere':
    'Guarda estos códigos de recuperación en un lugar seguro. Cada uno te permite iniciar sesión una vez si pierdes tu app de autenticación. No se volverán a mostrar.',
  'c_mfaSettings.iSavedThem': 'Ya los he guardado',
  'c_mfaSettings.couldNotStartTheSetup': 'No se pudo iniciar la configuración.',
  'c_mfaSettings.couldNotConfirmTheCode': 'No se pudo confirmar el código.',
  'c_mfaSettings.couldNotRegenerateTheCodes': 'No se pudieron regenerar los códigos.',
  'c_mfaSettings.couldNotTurnMfaOff': 'No se pudo desactivar MFA.',
  'c_mfaSettings.multiFactorAuthentication': 'Autenticación multifactor',
  'c_mfaSettings.protectYourAccountWithA':
    'Protege tu cuenta con un código de una app de autenticación. Se aplica en todas las organizaciones a las que perteneces.',
  'c_mfaSettings.currentPassword': 'Contraseña actual',
  'c_mfaSettings.setUpMfa': 'Configurar MFA',
  'c_mfaSettings.addThisKeyToYour':
    'Añade esta clave a tu app de autenticación y escribe el código que muestra.',
  'c_mfaSettings.setupKey': 'Clave de configuración',
  'c_mfaSettings.setupLink': 'Enlace de configuración',
  'c_mfaSettings.openInAuthenticator': 'Abrir en la app de autenticación',
  'c_mfaSettings.authenticationCode': 'Código de autenticación',
  'c_mfaSettings.turnOnMfa': 'Activar MFA',
  'c_mfaSettings.status': 'Estado',
  'c_mfaSettings.enabled': 'Activado',
  'c_mfaSettings.recoveryCodesLeft': 'Códigos de recuperación restantes',
  'c_mfaSettings.thisSession': 'Esta sesión',
  'c_mfaSettings.verifiedWithMfa': 'Verificada con MFA',
  'c_mfaSettings.notVerifiedWithMfa': 'Sin verificar con MFA',
  'c_mfaSettings.newRecoveryCodes': 'Nuevos códigos de recuperación',
  'c_mfaSettings.passwordToTurnMfaOff': 'Contraseña para desactivar MFA',
  'c_mfaSettings.turnOffMfa': 'Desactivar MFA',
  'c_mfaSettings.passwordRequiredToSetUp':
    'Introduce tu contraseña actual para empezar la configuración.',
  'c_mfaSettings.enterTheSixDigitCode':
    'El código de 6 dígitos que muestra ahora tu app de autenticación.',
  'c_mfaSettings.codeMustBeSixDigits': 'El código debe tener exactamente 6 dígitos.',
};

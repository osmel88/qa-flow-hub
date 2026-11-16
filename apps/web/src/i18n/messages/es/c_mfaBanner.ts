import type { c_mfaBanner as source } from '../en/c_mfaBanner';

export const c_mfaBanner: Partial<Record<keyof typeof source, string>> = {
  'c_mfaBanner.securityNotice': 'Aviso de seguridad',
  'c_mfaBanner.requiresMultiFactorAuthenticationSign':
    '{name} exige autenticación multifactor. Cierra sesión y vuelve a iniciarla con tu app de autenticación.',
  'c_mfaBanner.requiresMultiFactorAuthentication': '{name} exige autenticación multifactor.',
  'c_mfaBanner.setUpMfaInYour': 'Configura MFA en tu perfil',
};

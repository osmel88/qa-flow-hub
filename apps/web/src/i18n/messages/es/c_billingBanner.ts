import type { c_billingBanner as source } from '../en/c_billingBanner';

export const c_billingBanner: Partial<Record<keyof typeof source, string>> = {
  'c_billingBanner.billingNotice': 'Aviso de facturación',
  'c_billingBanner.billing': 'Facturación',
  'c_billingBanner.teamTrialEnds': 'Prueba del plan Team: termina el {date}.',
  'c_billingBanner.paymentFailed': 'El pago falló. Tu plan sigue activo hasta el {date}.',
  'c_billingBanner.overLimit':
    'El uso supera el plan {plan} en {resources}. Los datos existentes se conservan; los elementos nuevos están bloqueados.',
};

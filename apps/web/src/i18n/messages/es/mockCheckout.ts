import type { mockCheckout as source } from '../en/mockCheckout';

export const mockCheckout: Partial<Record<keyof typeof source, string>> = {
  'mockCheckout.thePaymentCouldNotBe': 'No se pudo simular el pago.',
  'mockCheckout.checkoutMockProvider': 'Pago (proveedor mock)',
  'mockCheckout.noCardIsChargedChoose': 'No se cobra ninguna tarjeta. Elige el resultado simulado.',
  'mockCheckout.month': '/ mes',
  'mockCheckout.pay': 'Pagar',
  'mockCheckout.simulateADeclinedCard': 'Simular una tarjeta rechazada',
  'mockCheckout.thisCheckoutIs': 'Este pago está',
};

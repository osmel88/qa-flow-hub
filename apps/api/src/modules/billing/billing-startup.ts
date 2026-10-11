import type { AppConfigService } from '../../config/app-config.service';
import { weakSecretReason } from '../../config/env.schema';

type BillingStartupConfig = Pick<AppConfigService, 'isProduction' | 'billing'>;

/**
 * Why a production instance must not boot with this billing configuration, or
 * `null`. The mock grants paid plans to anyone who clicks "pay", so production
 * fails closed until a real provider exists (S2-F11 decision 4).
 */
export function billingStartupProblem(config: BillingStartupConfig): string | null {
  if (!config.isProduction) {
    return null;
  }
  if (config.billing.provider === 'mock') {
    return 'BILLING_PROVIDER=mock is not allowed in production: configure a real billing provider';
  }
  const weak = weakSecretReason(config.billing.webhookSecret);
  if (weak !== null || config.billing.webhookSecret.startsWith('development-only')) {
    return `BILLING_WEBHOOK_SECRET is unsafe for production: ${weak ?? 'it is the development default'}`;
  }
  return null;
}

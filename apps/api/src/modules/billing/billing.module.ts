import { Module, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { BILLING_PROVIDER } from './billing-provider';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { billingStartupProblem } from './billing-startup';
import { BillingController } from './billing.controller';
import { BillingWebhooksController } from './billing-webhooks.controller';
import { BillingWebhooksService } from './billing-webhooks.service';
import { MockBillingProvider } from './mock/mock-billing.provider';
import { MockBillingStore } from './mock/mock-billing.store';
import { UsageLimitsService } from './usage-limits.service';

@Module({
  controllers: [BillingController, BillingWebhooksController],
  providers: [
    BillingRepository,
    BillingService,
    BillingWebhooksService,
    UsageLimitsService,
    MockBillingStore,
    MockBillingProvider,
    { provide: BILLING_PROVIDER, useExisting: MockBillingProvider },
  ],
  exports: [BillingService, UsageLimitsService, MockBillingStore],
})
export class BillingModule implements OnModuleInit {
  constructor(private readonly config: AppConfigService) {}

  onModuleInit(): void {
    const problem = billingStartupProblem(this.config);
    if (problem !== null) {
      throw new Error(problem);
    }
  }
}

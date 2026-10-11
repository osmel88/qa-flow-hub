import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { SkipOrganization } from '../auth/decorators/skip-organization.decorator';
import { BillingWebhooksService } from './billing-webhooks.service';

export const BILLING_WEBHOOK_ROUTE = 'billing/webhooks';

/**
 * Public on purpose — the caller is the provider, not a user — and therefore
 * authenticated by the HMAC signature alone. The raw body is captured before
 * JSON parsing (configure-app.ts), because a signature over re-serialised JSON
 * verifies nothing.
 */
@ApiExcludeController()
@Public()
@SkipOrganization()
@Controller(BILLING_WEBHOOK_ROUTE)
export class BillingWebhooksController {
  constructor(private readonly webhooks: BillingWebhooksService) {}

  @Post(':provider')
  @HttpCode(200)
  async receive(
    @Param('provider') provider: string,
    @Req() request: FastifyRequest & { rawBody?: Buffer },
  ): Promise<{ received: true; outcome: string }> {
    const outcome = await this.webhooks.handle(provider, request.rawBody, request.headers);
    return { received: true, outcome };
  }
}

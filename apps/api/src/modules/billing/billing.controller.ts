import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ChangePlanInput,
  CheckoutInput,
  CompleteMockCheckoutInput,
  ListInvoicesQuery,
  changePlanSchema,
  checkoutSchema,
  completeMockCheckoutSchema,
  listInvoicesQuerySchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { BillingService } from './billing.service';

/**
 * Billing is an organization-level concern, so it is gated by organization
 * role and not by project permissions: owners and admins can see what the
 * organization pays and uses; only owners can change it.
 */
@ApiTags('billing')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Organization-Id', required: true })
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @Roles('organization_owner', 'organization_admin')
  @ApiOperation({ summary: 'Effective plan, subscription, limits and usage' })
  overview() {
    return this.billing.overview();
  }

  @Get('invoices')
  @Roles('organization_owner', 'organization_admin')
  @ApiOperation({ summary: 'Invoices, newest first' })
  invoices(@Query(zodQuery(listInvoicesQuerySchema)) query: ListInvoicesQuery) {
    return this.billing.listInvoices(query);
  }

  @Post('checkout')
  @Roles('organization_owner')
  @ApiOperation({ summary: 'Start a hosted checkout for a paid plan' })
  checkout(
    @Body(zodBody(checkoutSchema)) input: CheckoutInput,
    @CurrentUser() user: CurrentUserContext,
  ) {
    return this.billing.checkout(input.plan, user.email);
  }

  @Post('plan')
  @HttpCode(200)
  @Roles('organization_owner')
  @ApiOperation({ summary: 'Upgrade now, or downgrade at the end of the period' })
  changePlan(@Body(zodBody(changePlanSchema)) input: ChangePlanInput) {
    return this.billing.changePlan(input.plan);
  }

  @Post('cancel')
  @HttpCode(200)
  @Roles('organization_owner')
  @ApiOperation({ summary: 'Cancel at the end of the period (idempotent)' })
  cancel() {
    return this.billing.cancel();
  }

  @Post('resume')
  @HttpCode(200)
  @Roles('organization_owner')
  @ApiOperation({ summary: 'Undo a scheduled cancellation' })
  resume() {
    return this.billing.resume();
  }

  // Mock provider only: 404 under any other provider, and production refuses
  // to boot with the mock at all.

  @Get('mock/checkout/:sessionId')
  @Roles('organization_owner')
  @ApiOperation({ summary: '[mock] Read a checkout session' })
  mockSession(@Param('sessionId') sessionId: string) {
    return this.billing.mockSession(sessionId);
  }

  @Post('mock/checkout/:sessionId/complete')
  @HttpCode(200)
  @Roles('organization_owner')
  @ApiOperation({ summary: '[mock] Pay or fail a checkout session' })
  completeMockCheckout(
    @Param('sessionId') sessionId: string,
    @Body(zodBody(completeMockCheckoutSchema)) input: CompleteMockCheckoutInput,
  ) {
    return this.billing.completeMockCheckout(sessionId, input.outcome);
  }

  @Post('mock/end-period')
  @HttpCode(200)
  @Roles('organization_owner')
  @ApiOperation({ summary: '[mock] End the current period (renewal, downgrade, cancellation)' })
  endMockPeriod(@Body(zodBody(completeMockCheckoutSchema)) input: CompleteMockCheckoutInput) {
    return this.billing.endMockPeriod(input.outcome);
  }
}

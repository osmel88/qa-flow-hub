import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ListNotificationsQuery,
  UpdateNotificationPreferencesInput,
  listNotificationsQuerySchema,
  updateNotificationPreferencesSchema,
} from '@qa-flow-hub/shared';
import { zodBody, zodQuery } from '../../common/pipes/zod-validation.pipe';
import { CurrentUser, CurrentUserContext } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { SkipOrganization } from '../auth/decorators/skip-organization.decorator';
import { NotificationsService } from './notifications.service';

/**
 * Two audiences under one prefix.
 *
 * Preferences belong to the person and are `@SkipOrganization()`: a user who
 * mutes assignment mail mutes it everywhere, and the settings page should work
 * before an organization is picked. The ledger and the outbox belong to a
 * tenant: `mine` is what the caller received in the active organization, and
 * the operator views (`scope=organization`, `/outbox`) need owner or admin.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @SkipOrganization()
  @Get('preferences')
  @ApiOperation({ summary: 'Notification preferences of the current user' })
  getPreferences(@CurrentUser() user: CurrentUserContext) {
    return this.notifications.getPreferences(user.userId);
  }

  @SkipOrganization()
  @Patch('preferences')
  @ApiOperation({ summary: 'Update notification preferences of the current user' })
  updatePreferences(
    @CurrentUser() user: CurrentUserContext,
    @Body(zodBody(updateNotificationPreferencesSchema)) body: UpdateNotificationPreferencesInput,
  ) {
    return this.notifications.updatePreferences(user.userId, body);
  }

  @ApiHeader({ name: 'X-Organization-Id', required: true })
  @Get('provider')
  @ApiOperation({ summary: 'Which email provider is configured and whether it is a mock' })
  provider() {
    return this.notifications.provider();
  }

  @ApiHeader({ name: 'X-Organization-Id', required: true })
  @Get()
  @ApiOperation({
    summary: 'Notification ledger: mine, or the whole organization for owners/admins',
  })
  list(
    @CurrentUser() user: CurrentUserContext,
    @Query(zodQuery(listNotificationsQuerySchema)) query: ListNotificationsQuery,
  ) {
    return this.notifications.list({ userId: user.userId, role: user.role }, query);
  }

  @ApiHeader({ name: 'X-Organization-Id', required: true })
  @RequirePermission('notifications.manage')
  @Get('outbox')
  @ApiOperation({
    summary: 'Development outbox: messages the mock provider captured for this organization',
  })
  outbox(
    @CurrentUser() user: CurrentUserContext,
    @Query(zodQuery(listNotificationsQuerySchema)) query: ListNotificationsQuery,
  ) {
    return this.notifications.outbox({ role: user.role }, query);
  }
}

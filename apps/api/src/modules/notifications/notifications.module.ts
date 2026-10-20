import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { AuditModule } from '../audit/audit.module';
import { NotificationOutboxWorker } from './notification-outbox.worker';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

/**
 * Nothing imports this module and it imports no business module: it hears
 * about the world through domain events and reads what it needs with its own
 * repository. That is what lets invitations, auth, runs and defects publish an
 * event without depending on how — or whether — anyone turns it into email.
 */
@Module({
  imports: [IntegrationsModule, AuditModule],
  controllers: [NotificationsController],
  providers: [NotificationsRepository, NotificationsService, NotificationOutboxWorker],
  exports: [NotificationsService, NotificationOutboxWorker],
})
export class NotificationsModule {}

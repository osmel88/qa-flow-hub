import { Global, Module } from '@nestjs/common';
import { DomainEventsPublisher } from './domain-events';

/** Global because every business module may publish; none may listen here. */
@Global()
@Module({
  providers: [DomainEventsPublisher],
  exports: [DomainEventsPublisher],
})
export class DomainEventsModule {}

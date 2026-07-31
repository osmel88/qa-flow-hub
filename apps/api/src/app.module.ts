import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './modules/health/health.module';

/**
 * Composition root of the modular monolith.
 *
 * Feature modules are registered here and nowhere else, which makes the module
 * graph readable at a glance and keeps cross-module imports honest: if a module
 * needs another module's data, it imports that module and uses its public
 * service, instead of reaching into its repository.
 */
@Module({
  imports: [
    AppConfigModule,
    // In-process event bus. Audit and future integration side effects subscribe
    // to domain events instead of being called inline from services.
    EventEmitterModule.forRoot({ global: true, wildcard: true, verboseMemoryLeak: true }),
    HealthModule,
  ],
})
export class AppModule {}

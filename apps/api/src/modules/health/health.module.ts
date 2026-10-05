import { Module } from '@nestjs/common';
import { StorageModule } from '../../storage/storage.module';
import { AppLifecycleService } from './app-lifecycle.service';
import { HealthController } from './health.controller';
import { ReadinessService } from './readiness.service';

@Module({
  imports: [StorageModule],
  controllers: [HealthController],
  providers: [ReadinessService, AppLifecycleService],
  exports: [AppLifecycleService],
})
export class HealthModule {}

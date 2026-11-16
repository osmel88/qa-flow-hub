import { Module } from '@nestjs/common';
import { FlakyModule } from '../flaky/flaky.module';
import { ProjectsModule } from '../projects/projects.module';
import { TestPlansModule } from '../test-plans/test-plans.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';
import { DashboardController } from './dashboard.controller';
import { DashboardRepository } from './dashboard.repository';
import { DashboardService } from './dashboard.service';
import { QaMetricsController } from './qa-metrics.controller';
import { QaMetricsRepository } from './qa-metrics.repository';
import { QaMetricsService } from './qa-metrics.service';

@Module({
  imports: [ProjectsModule, TestPlansModule, FlakyModule],
  controllers: [DashboardController, AnalyticsController, QaMetricsController],
  providers: [
    DashboardService,
    DashboardRepository,
    AnalyticsService,
    AnalyticsRepository,
    QaMetricsService,
    QaMetricsRepository,
  ],
})
export class DashboardModule {}

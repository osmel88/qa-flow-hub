import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';
import { DashboardController } from './dashboard.controller';
import { DashboardRepository } from './dashboard.repository';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [ProjectsModule],
  controllers: [DashboardController, AnalyticsController],
  providers: [DashboardService, DashboardRepository, AnalyticsService, AnalyticsRepository],
})
export class DashboardModule {}

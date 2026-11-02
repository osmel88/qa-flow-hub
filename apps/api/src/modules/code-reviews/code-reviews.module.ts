import { Module } from '@nestjs/common';
import { DevelopmentModule } from '../development/development.module';
import { ProjectsModule } from '../projects/projects.module';
import { CodeReviewsController, WorkItemCodeReviewsController } from './code-reviews.controller';
import { CodeReviewsRepository } from './code-reviews.repository';
import { CodeReviewsService } from './code-reviews.service';

/** Internal, provider-neutral code reviews (S5-F3). */
@Module({
  imports: [ProjectsModule, DevelopmentModule],
  controllers: [CodeReviewsController, WorkItemCodeReviewsController],
  providers: [CodeReviewsService, CodeReviewsRepository],
})
export class CodeReviewsModule {}

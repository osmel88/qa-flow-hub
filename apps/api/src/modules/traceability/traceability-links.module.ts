import { Module } from '@nestjs/common';
import { TraceabilityLinksRepository } from './traceability-links.repository';

/**
 * Deliberately tiny: every module that can delete a linkable entity imports
 * this one, and nothing else comes with it. Exporting the purge from
 * `TraceabilityModule` would drag the whole read side — and its dependency on
 * defects and projects — into requirements and test design, which is how import
 * cycles start.
 */
@Module({
  providers: [TraceabilityLinksRepository],
  exports: [TraceabilityLinksRepository],
})
export class TraceabilityLinksModule {}

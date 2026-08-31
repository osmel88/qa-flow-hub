import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Global because every functional module writes audit entries, and threading
 * an import of the same module through all of them adds noise without adding
 * information. It exports one stateless service and nothing else.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}

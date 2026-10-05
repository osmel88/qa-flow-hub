import { Global, Module } from '@nestjs/common';
import { DatabaseRoleInspector } from './database-role.inspector';
import { PrismaService } from './prisma.service';
import { TenantContextService } from './tenant-context.service';

/**
 * Global because every module needs the client and the request context, and
 * re-importing this in a dozen modules would be noise without benefit.
 */
@Global()
@Module({
  providers: [PrismaService, TenantContextService, DatabaseRoleInspector],
  exports: [PrismaService, TenantContextService, DatabaseRoleInspector],
})
export class DatabaseModule {}

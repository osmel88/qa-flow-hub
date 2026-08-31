import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TenantContextService } from './tenant-context.service';

/**
 * Global because every module needs the client and the request context, and
 * re-importing this in a dozen modules would be noise without benefit.
 */
@Global()
@Module({
  providers: [PrismaService, TenantContextService],
  exports: [PrismaService, TenantContextService],
})
export class DatabaseModule {}

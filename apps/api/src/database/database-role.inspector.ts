import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from './prisma.service';

export interface DatabaseRoleInfo {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  ownsTables: boolean;
}

/**
 * Why a role would make Row Level Security decorative, or an empty list.
 *
 * PostgreSQL skips the policies for a superuser, for a role with BYPASSRLS
 * and for the owner of the table. Any of the three means the tenant boundary
 * is down to application code alone — exactly what the policies exist to
 * back up.
 */
export function databaseRoleProblems(info: DatabaseRoleInfo): string[] {
  return [
    ...(info.superuser ? ['is a superuser'] : []),
    ...(info.bypassRls ? ['has BYPASSRLS'] : []),
    ...(info.ownsTables ? ['owns application tables'] : []),
  ];
}

export type DatabaseRoleStatus = 'safe' | 'unsafe' | 'unknown';

/**
 * Checks, once at boot, who `DATABASE_URL` actually connects as.
 *
 * In production an unsafe role stops the process: shipping with the owner URL
 * is a one-line configuration mistake that no test catches, because every
 * request still works — it just stops being isolated by the database. In
 * development and test the owner is normal (the integration suites run as it)
 * and the finding is a warning.
 */
@Injectable()
export class DatabaseRoleInspector implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatabaseRoleInspector.name);
  private result: DatabaseRoleStatus = 'unknown';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  get status(): DatabaseRoleStatus {
    return this.result;
  }

  async onApplicationBootstrap(): Promise<void> {
    const info = await this.inspect();
    const problems = databaseRoleProblems(info);
    this.result = problems.length === 0 ? 'safe' : 'unsafe';

    if (problems.length === 0) {
      return;
    }

    const message =
      `DATABASE_URL connects as "${info.role}", which ${problems.join(', ')}: ` +
      'Row Level Security does not apply to it. Connect as the non-owning runtime role (qaflow_app).';

    if (this.config.isProduction) {
      throw new Error(`Refusing to start. ${message}`);
    }
    this.logger.warn(message);
  }

  async inspect(): Promise<DatabaseRoleInfo> {
    const [row] = await this.prisma.$queryRaw<
      Array<{ role: string; superuser: boolean; bypass_rls: boolean; owns_tables: boolean }>
    >`
      SELECT current_user AS role,
             r.rolsuper AS superuser,
             r.rolbypassrls AS bypass_rls,
             EXISTS (
               SELECT 1 FROM pg_tables
               WHERE schemaname = 'public' AND tableowner = current_user
             ) AS owns_tables
      FROM pg_roles r
      WHERE r.rolname = current_user
    `;

    if (row === undefined) {
      throw new Error('Could not inspect the database role of DATABASE_URL');
    }

    return {
      role: row.role,
      superuser: row.superuser,
      bypassRls: row.bypass_rls,
      ownsTables: row.owns_tables,
    };
  }
}

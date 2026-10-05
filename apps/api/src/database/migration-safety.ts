/**
 * Static review of SQL migrations before they reach a database.
 *
 * Deployments run `prisma migrate deploy` while the previous release is still
 * serving traffic, so a migration has to be compatible with the code before it
 * (expand first, contract in a later release). The statements below are the
 * ones that break that rule or weaken the tenant boundary: they are refused
 * unless the migration says, in a comment, that it knows and why:
 *
 *   -- migration-safety: allow drop-column: column unused since release 1.4
 *
 * It is a net for the mistakes a reviewer misses at 6 pm, not a SQL parser.
 */

export interface MigrationRule {
  id: string;
  pattern: RegExp;
  why: string;
}

export const MIGRATION_RULES: readonly MigrationRule[] = [
  {
    id: 'drop-table',
    pattern: /\bDROP\s+TABLE\b/gi,
    why: 'destroys data the previous release still reads',
  },
  {
    id: 'drop-column',
    pattern: /\bDROP\s+COLUMN\b/gi,
    why: 'the previous release still selects the column',
  },
  { id: 'drop-schema', pattern: /\bDROP\s+SCHEMA\b/gi, why: 'destroys everything in the schema' },
  {
    id: 'drop-type',
    pattern: /\bDROP\s+TYPE\b/gi,
    why: 'columns of the previous release use the type',
  },
  { id: 'truncate', pattern: /\bTRUNCATE\b/gi, why: 'deletes every row' },
  {
    id: 'rename',
    pattern: /\bRENAME\s+(?:COLUMN\b|CONSTRAINT\b|TO\b)/gi,
    why: 'the previous release still uses the old name',
  },
  {
    id: 'alter-column-type',
    pattern: /\bALTER\s+COLUMN\s+"?[\w]+"?\s+(?:SET\s+DATA\s+)?TYPE\b/gi,
    why: 'rewrites the table under an exclusive lock and can fail on existing rows',
  },
  {
    id: 'set-not-null',
    pattern: /\bSET\s+NOT\s+NULL\b/gi,
    why: 'fails on existing NULLs and the previous release may still write them',
  },
  {
    id: 'delete-without-where',
    pattern: /\bDELETE\s+FROM\s+"?[\w.]+"?\s*(?:;|$)/gi,
    why: 'deletes every row',
  },
  {
    id: 'rls-weakening',
    pattern:
      /\b(?:DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY|DROP\s+POLICY|BYPASSRLS)\b/gi,
    why: 'weakens the tenant isolation Row Level Security enforces',
  },
];

const ALLOW_MARKER = /--\s*migration-safety:\s*allow\s+([a-z-]+)\s*:\s*(\S.*)$/gim;
const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+$/;

export interface MigrationFinding {
  migration: string;
  rule: string;
  line: number;
  message: string;
}

/** The findings for one migration's SQL. */
export function reviewMigrationSql(migration: string, sql: string): MigrationFinding[] {
  const allowed = new Set<string>();
  for (const marker of sql.matchAll(ALLOW_MARKER)) {
    if (marker[1] !== undefined) {
      allowed.add(marker[1]);
    }
  }

  // Comments are blanked, not removed, so match offsets still map to lines.
  const code = sql.replace(/--[^\n]*/g, (comment) => ' '.repeat(comment.length));

  const findings: MigrationFinding[] = [];
  for (const rule of MIGRATION_RULES) {
    if (allowed.has(rule.id)) {
      continue;
    }
    for (const match of code.matchAll(rule.pattern)) {
      findings.push({
        migration,
        rule: rule.id,
        line: code.slice(0, match.index).split('\n').length,
        message: `${rule.id}: ${rule.why}. Add "-- migration-safety: allow ${rule.id}: <reason>" if intended.`,
      });
    }
  }
  return findings;
}

/**
 * Structural findings across the migration directory: a name Prisma would sort
 * wrongly, a folder without SQL, or a new migration dated before the reviewed
 * history — which `migrate deploy` would apply out of order on a fresh
 * database and not at all on one that is up to date.
 */
export function reviewMigrationLayout(
  migrations: ReadonlyArray<{ name: string; hasSql: boolean }>,
  reviewedHistory: readonly string[],
): MigrationFinding[] {
  const findings: MigrationFinding[] = [];
  const reviewed = new Set(reviewedHistory);
  const lastReviewed = [...reviewedHistory].sort().at(-1) ?? '';

  for (const { name, hasSql } of migrations) {
    const finding = (rule: string, message: string): void => {
      findings.push({ migration: name, rule, line: 0, message });
    };
    if (!MIGRATION_NAME.test(name)) {
      finding('name', 'expected <14-digit timestamp>_<snake_case_name>');
    }
    if (!hasSql) {
      finding('missing-sql', 'the folder has no migration.sql');
    }
    if (!reviewed.has(name) && name <= lastReviewed) {
      finding('out-of-order', `dated before the last reviewed migration (${lastReviewed})`);
    }
  }
  for (const name of reviewedHistory) {
    if (!migrations.some((migration) => migration.name === name)) {
      findings.push({
        migration: name,
        rule: 'removed',
        line: 0,
        message: 'a migration already applied in deployed databases was deleted',
      });
    }
  }
  return findings;
}

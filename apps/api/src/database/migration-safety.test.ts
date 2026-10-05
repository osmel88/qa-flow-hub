import { describe, expect, it } from 'vitest';
import { reviewMigrationLayout, reviewMigrationSql } from './migration-safety';

const rules = (sql: string): string[] =>
  reviewMigrationSql('m', sql).map((finding) => finding.rule);

describe('reviewMigrationSql', () => {
  it('accepts additive changes', () => {
    expect(
      rules(`
        CREATE TABLE "widgets" ("id" TEXT NOT NULL);
        ALTER TABLE "widgets" ADD COLUMN "name" TEXT;
        CREATE INDEX "widgets_name_idx" ON "widgets"("name");
        ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;
        DELETE FROM "widgets" WHERE "name" IS NULL;
      `),
    ).toEqual([]);
  });

  it.each([
    ['DROP TABLE "widgets";', 'drop-table'],
    ['ALTER TABLE "widgets" DROP COLUMN "name";', 'drop-column'],
    ['TRUNCATE "widgets";', 'truncate'],
    ['ALTER TABLE "widgets" RENAME COLUMN "a" TO "b";', 'rename'],
    ['ALTER TABLE "widgets" ALTER COLUMN "name" SET DATA TYPE INTEGER;', 'alter-column-type'],
    ['ALTER TABLE "widgets" ALTER COLUMN "name" SET NOT NULL;', 'set-not-null'],
    ['DELETE FROM "widgets";', 'delete-without-where'],
    ['ALTER TABLE "widgets" DISABLE ROW LEVEL SECURITY;', 'rls-weakening'],
    ['DROP POLICY tenant_isolation ON "widgets";', 'rls-weakening'],
    ['ALTER ROLE qaflow_app BYPASSRLS;', 'rls-weakening'],
  ])('flags %s', (sql, rule) => {
    expect(rules(sql)).toContain(rule);
  });

  it('accepts a destructive statement the migration explicitly allows, with a reason', () => {
    const sql = [
      '-- migration-safety: allow drop-column: unused since the contract release',
      'ALTER TABLE "widgets" DROP COLUMN "legacy";',
    ].join('\n');

    expect(rules(sql)).toEqual([]);
  });

  it('does not accept a marker without a reason', () => {
    expect(
      rules('-- migration-safety: allow drop-column\nALTER TABLE "w" DROP COLUMN "x";'),
    ).toEqual(['drop-column']);
  });

  it('ignores statements that only appear in comments and reports the line', () => {
    const findings = reviewMigrationSql('m', '-- DROP TABLE "old";\nSELECT 1;\nDROP TABLE "real";');

    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(3);
  });
});

describe('reviewMigrationLayout', () => {
  const history = ['20260101000000_init', '20260201000000_second'];

  it('accepts the reviewed history plus a newer migration', () => {
    const migrations = [...history, '20260301000000_third'].map((name) => ({ name, hasSql: true }));

    expect(reviewMigrationLayout(migrations, history)).toEqual([]);
  });

  it('flags a new migration dated inside the reviewed history', () => {
    const migrations = [...history, '20260115000000_sneaky'].map((name) => ({
      name,
      hasSql: true,
    }));

    expect(reviewMigrationLayout(migrations, history).map((f) => f.rule)).toEqual(['out-of-order']);
  });

  it('flags a deleted applied migration, a bad name and a folder without SQL', () => {
    const findings = reviewMigrationLayout(
      [
        { name: '20260101000000_init', hasSql: true },
        { name: 'third', hasSql: false },
      ],
      history,
    );

    expect(findings.map((f) => f.rule).sort()).toEqual(['missing-sql', 'name', 'removed']);
  });
});

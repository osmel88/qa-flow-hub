import { describe, expect, it } from 'vitest';
import { InvalidReportError, ReportTooLargeError } from '../../../errors';
import { parsePlaywrightJson } from './playwright-json.parser';

const LIMITS = { maxTests: 10 };
const parse = (value: unknown) =>
  parsePlaywrightJson(
    Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
    LIMITS,
  );

describe('parsePlaywrightJson', () => {
  it('walks nested suites and maps every test status', () => {
    const report = parse({
      suites: [
        {
          title: 'auth.spec.ts',
          specs: [
            {
              title: 'logs in',
              tags: ['@WEB-C-1'],
              tests: [
                { projectName: 'chromium', status: 'expected', results: [{ duration: 1500 }] },
              ],
            },
          ],
          suites: [
            {
              title: 'logout',
              specs: [
                {
                  title: 'flaky',
                  tests: [{ status: 'flaky', results: [{ duration: 100 }, { duration: 200 }] }],
                },
                {
                  title: 'breaks',
                  tests: [
                    {
                      status: 'unexpected',
                      annotations: [{ type: 'issue', description: 'WEB-C-2' }],
                      results: [{ duration: 300, error: { message: '\u001b[31mred\u001b[39m' } }],
                    },
                  ],
                },
                { title: 'later', tests: [{ status: 'skipped', results: [] }] },
              ],
            },
          ],
        },
      ],
    });
    expect(report.tests.map((test) => [test.outcome, test.durationMs])).toEqual([
      ['passed', 1500],
      ['passed', 300],
      ['failed', 300],
      ['skipped', null],
    ]);
    expect(report.tests[0]!.name).toContain('logs in');
    expect(report.tests[0]!.hints.join(' ')).toContain('WEB-C-1');
    expect(report.tests[2]!.hints.join(' ')).toContain('WEB-C-2');
    expect(report.tests[2]!.error).toBe('red');
  });

  it.each([
    ['', 'REPORT_EMPTY'],
    ['{"suites": [', 'REPORT_MALFORMED'],
    ['[]', 'REPORT_UNSUPPORTED'],
    ['{"tests": []}', 'REPORT_UNSUPPORTED'],
    ['{"suites": [{"specs": [{"tests": [{"status": "weird"}]}]}]}', 'REPORT_MALFORMED'],
    ['{"suites": [{"specs": "nope"}]}', 'REPORT_MALFORMED'],
  ])('rejects %j as %s', (json, reason) => {
    try {
      parse(json);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidReportError);
      expect((error as InvalidReportError).reason).toBe(reason);
    }
  });

  it('enforces the test count limit', () => {
    const specs = Array.from({ length: 11 }, (_, index) => ({
      title: `t${index}`,
      tests: [{ status: 'expected' }],
    }));
    expect(() => parse({ suites: [{ title: 's', specs }] })).toThrow(ReportTooLargeError);
  });
});

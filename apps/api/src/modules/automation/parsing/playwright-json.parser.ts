import { InvalidReportError } from '../../../errors';
import {
  MAX_DEPTH,
  MAX_ERROR_LENGTH,
  MAX_NAME_LENGTH,
  ParseLimits,
  ParsedReport,
  ParsedTest,
  assertTestCount,
  decodeReport,
  truncate,
} from './report';

type Json = Record<string, unknown>;

/**
 * The Playwright JSON reporter (`--reporter=json`): nested `suites`, each with
 * `specs`, each spec with one `test` per project. A test's final `status` is
 * what counts: `expected` and `flaky` (passed on retry) are passed,
 * `unexpected` is failed, `skipped` is skipped.
 *
 * Playwright's `junit` reporter is plain JUnit XML and goes to the JUnit
 * endpoint.
 */
export function parsePlaywrightJson(buffer: Buffer, limits: ParseLimits): ParsedReport {
  const text = decodeReport(buffer);
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid JSON';
    throw new InvalidReportError('REPORT_MALFORMED', `Malformed JSON: ${truncate(message, 200)}`);
  }
  if (!isObject(document) || !Array.isArray(document['suites'])) {
    throw new InvalidReportError(
      'REPORT_UNSUPPORTED',
      'Expected a Playwright JSON report: an object with a "suites" array',
    );
  }

  const tests: ParsedTest[] = [];
  const visit = (suite: unknown, path: string[], depth: number): void => {
    if (depth > MAX_DEPTH) {
      throw new InvalidReportError(
        'REPORT_MALFORMED',
        `Suites are nested deeper than ${MAX_DEPTH}`,
      );
    }
    if (!isObject(suite)) {
      throw new InvalidReportError('REPORT_MALFORMED', 'Every suite must be an object');
    }
    const title = text_(suite['title']);
    const file = text_(suite['file']);
    const here = title.length > 0 && title !== file ? [...path, title] : path;
    for (const spec of arrayOf(suite['specs'], 'specs')) {
      if (!isObject(spec)) {
        throw new InvalidReportError('REPORT_MALFORMED', 'Every spec must be an object');
      }
      const specTitle = text_(spec['title']);
      const specFile = text_(spec['file']) || file;
      const tags = arrayOf(spec['tags'], 'tags').filter(
        (tag): tag is string => typeof tag === 'string',
      );
      for (const test of arrayOf(spec['tests'], 'tests')) {
        if (!isObject(test)) {
          throw new InvalidReportError('REPORT_MALFORMED', 'Every test must be an object');
        }
        assertTestCount(tests.length + 1, limits);
        tests.push(toTest(test, [...here, specTitle], specFile, tags));
      }
    }
    for (const child of arrayOf(suite['suites'], 'suites')) {
      visit(child, here, depth + 1);
    }
  };
  for (const suite of document['suites'] as unknown[]) {
    visit(suite, [], 1);
  }

  return { title: null, tests };
}

function toTest(test: Json, path: string[], file: string, tags: string[]): ParsedTest {
  const project = text_(test['projectName']);
  const results = arrayOf(test['results'], 'results').filter(isObject);
  const annotations = arrayOf(test['annotations'], 'annotations')
    .filter(isObject)
    .map((annotation) => text_(annotation['description']))
    .filter((description) => description.length > 0);

  const durations = results
    .map((result) => result['duration'])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const last = results.at(-1);
  const name = [...path.filter((part) => part.length > 0)].join(' > ');

  return {
    name: truncate(
      `${name || '(unnamed test)'}${project.length > 0 ? ` [${project}]` : ''}`,
      MAX_NAME_LENGTH,
    ),
    outcome: outcomeOf(text_(test['status'])),
    durationMs:
      durations.length === 0
        ? null
        : Math.round(durations.reduce((sum, value) => sum + Math.max(0, value), 0)),
    error: last === undefined ? null : errorOf(last),
    hints: [...path, file, ...tags, ...annotations].filter((hint) => hint.length > 0),
  };
}

function outcomeOf(status: string): ParsedTest['outcome'] {
  switch (status) {
    case 'expected':
    case 'flaky':
      return 'passed';
    case 'unexpected':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      throw new InvalidReportError(
        'REPORT_MALFORMED',
        `Unknown test status "${truncate(status, 40)}"; expected expected, unexpected, flaky or skipped`,
      );
  }
}

function errorOf(result: Json): string | null {
  const candidates = [result['error'], ...arrayOf(result['errors'], 'errors')];
  for (const candidate of candidates) {
    if (isObject(candidate)) {
      const message = text_(candidate['message']);
      if (message.length > 0) {
        return truncate(stripAnsi(message), MAX_ERROR_LENGTH);
      }
    }
  }
  return null;
}

function arrayOf(value: unknown, field: string): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new InvalidReportError('REPORT_MALFORMED', `"${field}" must be an array`);
  }
  return value;
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text_(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Playwright colours its messages for the terminal. */
function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

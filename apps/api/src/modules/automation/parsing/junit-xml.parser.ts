import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { InvalidReportError, ReportTooLargeError } from '../../../errors';
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

/**
 * Matches a DTD or an entity declaration anywhere in the document. Checked
 * before parsing: a document with a DTD is refused outright, so neither
 * external entities (XXE) nor entity expansion ("billion laughs") can reach
 * the parser. saxes would not fetch or expand them either — it knows only the
 * five predefined entities — but refusing early is the property worth testing.
 */
const DTD_PATTERN = /<!\s*(DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)\b/i;

interface OpenCase {
  name: string;
  classname: string;
  file: string;
  durationMs: number | null;
  outcome: ParsedTest['outcome'];
  error: string | null;
  hints: string[];
}

/**
 * JUnit XML as written by Surefire, pytest, Jest, Vitest, Playwright (`junit`
 * reporter) and most CI tools: `<testsuites>` or a single `<testsuite>`, each
 * `<testcase>` passed unless it holds `<failure>`, `<error>` or `<skipped>`.
 *
 * Streaming (SAX) on purpose: no DOM, no recursion, constant stack whatever
 * the nesting, and nothing in the document can make the parser load a file or
 * a URL.
 */
export function parseJUnitXml(buffer: Buffer, limits: ParseLimits): ParsedReport {
  const text = decodeReport(buffer);
  if (DTD_PATTERN.test(text)) {
    throw new InvalidReportError(
      'REPORT_DTD_FORBIDDEN',
      'Document type declarations and entities are not accepted',
    );
  }

  const parser = new SaxesParser({ xmlns: false, position: true });
  const tests: ParsedTest[] = [];
  const suites: string[] = [];
  let depth = 0;
  let root: string | null = null;
  let title: string | null = null;
  let current: OpenCase | null = null;
  /** Element whose text is the failure message (`failure`, `error`, `skipped`). */
  let capturing: { text: string } | null = null;
  const state: { failure: InvalidReportError | null } = { failure: null };

  const fail = (reason: InvalidReportError): void => {
    state.failure ??= reason;
  };

  parser.on('doctype', () => {
    fail(
      new InvalidReportError(
        'REPORT_DTD_FORBIDDEN',
        'Document type declarations and entities are not accepted',
      ),
    );
  });

  parser.on('opentag', (tag: SaxesTagPlain) => {
    depth += 1;
    if (depth > MAX_DEPTH) {
      fail(
        new InvalidReportError('REPORT_MALFORMED', `Elements are nested deeper than ${MAX_DEPTH}`),
      );
      return;
    }
    const name = tag.name;
    if (root === null) {
      root = name;
      if (name !== 'testsuites' && name !== 'testsuite') {
        fail(
          new InvalidReportError(
            'REPORT_UNSUPPORTED',
            `Expected <testsuites> or <testsuite> as the root element, found <${name}>`,
          ),
        );
        return;
      }
      title = attribute(tag, 'name');
    }
    if (name === 'testsuite') {
      suites.push(attribute(tag, 'name') ?? '');
      return;
    }
    if (name === 'testcase') {
      if (current !== null) {
        fail(new InvalidReportError('REPORT_MALFORMED', '<testcase> elements cannot be nested'));
        return;
      }
      const testName = attribute(tag, 'name') ?? '';
      const classname = attribute(tag, 'classname') ?? '';
      const file = attribute(tag, 'file') ?? '';
      current = {
        name: testName,
        classname,
        file,
        durationMs: seconds(attribute(tag, 'time')),
        outcome: 'passed',
        error: null,
        hints: [classname, file].filter((hint) => hint.length > 0),
      };
      assertTestCount(tests.length + 1, limits);
      return;
    }
    if (current === null) {
      return;
    }
    if (name === 'failure' || name === 'error') {
      current.outcome = 'failed';
      capturing = { text: attribute(tag, 'message') ?? '' };
    } else if (name === 'skipped') {
      // A failure wins over a skip marker in the same test case.
      if (current.outcome !== 'failed') {
        current.outcome = 'skipped';
      }
    } else if (name === 'property') {
      const value = attribute(tag, 'value');
      if (value !== null) {
        current.hints.push(value);
      }
    }
  });

  parser.on('text', (value: string) => {
    if (capturing !== null && capturing.text.length < MAX_ERROR_LENGTH) {
      capturing.text += capturing.text.length === 0 ? value : `\n${value}`;
    }
  });
  parser.on('cdata', (value: string) => {
    if (capturing !== null && capturing.text.length < MAX_ERROR_LENGTH) {
      capturing.text += capturing.text.length === 0 ? value : `\n${value}`;
    }
  });

  parser.on('closetag', (tag) => {
    depth -= 1;
    const name = tag.name;
    if ((name === 'failure' || name === 'error') && current !== null && capturing !== null) {
      current.error ??= truncate(capturing.text, MAX_ERROR_LENGTH) || null;
      capturing = null;
    } else if (name === 'testcase' && current !== null) {
      const suitePath = suites.filter((suite) => suite.length > 0);
      const parts = [...suitePath, current.classname, current.name].filter(
        (part, index, all) => part.length > 0 && all.indexOf(part) === index,
      );
      tests.push({
        name: truncate(parts.join(' > ') || '(unnamed test)', MAX_NAME_LENGTH),
        outcome: current.outcome,
        durationMs: current.durationMs,
        error: current.error,
        hints: [current.name, ...current.hints],
      });
      current = null;
    } else if (name === 'testsuite') {
      suites.pop();
    }
  });

  try {
    parser.write(text).close();
  } catch (error) {
    if (state.failure !== null) {
      throw state.failure;
    }
    if (error instanceof InvalidReportError || error instanceof ReportTooLargeError) {
      throw error;
    }
    throw new InvalidReportError('REPORT_MALFORMED', `Malformed XML: ${xmlMessage(error)}`);
  }
  if (state.failure !== null) {
    throw state.failure;
  }
  if (root === null) {
    throw new InvalidReportError('REPORT_MALFORMED', 'The document has no root element');
  }
  return { title, tests };
}

function attribute(tag: SaxesTagPlain, name: string): string | null {
  const value = tag.attributes[name];
  return typeof value === 'string' ? value : null;
}

function seconds(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1000) : null;
}

/** saxes messages look like "1:12: unexpected end." — position kept, nothing else. */
function xmlMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncate(message, 200);
}

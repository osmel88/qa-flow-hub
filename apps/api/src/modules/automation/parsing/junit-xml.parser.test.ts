import { describe, expect, it } from 'vitest';
import { InvalidReportError, ReportTooLargeError } from '../../../errors';
import { parseJUnitXml } from './junit-xml.parser';

const LIMITS = { maxTests: 100 };
const parse = (xml: string | Buffer) =>
  parseJUnitXml(Buffer.isBuffer(xml) ? xml : Buffer.from(xml), LIMITS);

const reasonOf = (xml: string | Buffer): string => {
  try {
    parse(xml);
  } catch (error) {
    if (error instanceof InvalidReportError) {
      return error.reason;
    }
    throw error;
  }
  throw new Error('expected the report to be rejected');
};

describe('parseJUnitXml', () => {
  it('maps suites, test names, outcomes, durations and errors', () => {
    const report = parse(
      '\uFEFF<?xml version="1.0" encoding="UTF-8"?>' +
        '<testsuites name="ci"><testsuite name="checkout"><testsuite name="cards">' +
        '<testcase classname="pay.spec" name="WEB-C-1 pays" time="1.25"/>' +
        '<testcase name="fails" time="0.5"><failure message="Expected 1">stack &amp; trace</failure></testcase>' +
        '<testcase name="errors"><error message="boom"><![CDATA[<raw>]]></error></testcase>' +
        '<testcase name="skips"><skipped message="later"/></testcase>' +
        '</testsuite></testsuite></testsuites>',
    );
    expect(report.title).toBe('ci');
    expect(report.tests.map((test) => [test.name, test.outcome, test.durationMs])).toEqual([
      ['checkout > cards > pay.spec > WEB-C-1 pays', 'passed', 1250],
      ['checkout > cards > fails', 'failed', 500],
      ['checkout > cards > errors', 'failed', null],
      ['checkout > cards > skips', 'skipped', null],
    ]);
    expect(report.tests[1]!.error).toContain('Expected 1');
    expect(report.tests[1]!.error).toContain('stack & trace');
    expect(report.tests[2]!.error).toContain('<raw>');
    expect(report.tests[0]!.hints.join(' ')).toContain('WEB-C-1');
  });

  it('accepts a single <testsuite> root and properties as hints', () => {
    const report = parse(
      '<testsuite name="s"><testcase name="t"><properties><property name="case" value="WEB-C-7"/></properties></testcase></testsuite>',
    );
    expect(report.tests).toHaveLength(1);
    expect(report.tests[0]!.hints.join(' ')).toContain('WEB-C-7');
  });

  it('truncates long error messages', () => {
    const report = parse(
      `<testsuite><testcase name="t"><failure>${'x'.repeat(5_000)}</failure></testcase></testsuite>`,
    );
    expect(report.tests[0]!.error!.length).toBeLessThanOrEqual(2_001);
  });

  it.each([
    [
      '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><testsuite>&e;</testsuite>',
      'REPORT_DTD_FORBIDDEN',
    ],
    [
      '<?xml version="1.0"?>\n<!doctype testsuite SYSTEM "http://x/y.dtd"><testsuite/>',
      'REPORT_DTD_FORBIDDEN',
    ],
    ['<testsuite><!ENTITY a "b"></testsuite>', 'REPORT_DTD_FORBIDDEN'],
    ['<testsuite><!ATTLIST a b CDATA #IMPLIED></testsuite>', 'REPORT_DTD_FORBIDDEN'],
    ['', 'REPORT_EMPTY'],
    ['\uFEFF  ', 'REPORT_EMPTY'],
    ['<testsuite>', 'REPORT_MALFORMED'],
    ['<testsuite><testcase name="a &x;"/></testsuite>', 'REPORT_MALFORMED'],
    ['<testsuite><testcase><testcase/></testcase></testsuite>', 'REPORT_MALFORMED'],
    ['<testsuite/><testsuite/>', 'REPORT_MALFORMED'],
    ['<project/>', 'REPORT_UNSUPPORTED'],
    [
      `<testsuites>${'<testsuite>'.repeat(40)}${'</testsuite>'.repeat(40)}</testsuites>`,
      'REPORT_MALFORMED',
    ],
  ])('rejects %j as %s', (xml, reason) => {
    expect(reasonOf(xml)).toBe(reason);
  });

  it('rejects invalid UTF-8', () => {
    expect(reasonOf(Buffer.from([0x3c, 0x61, 0xc3, 0x28, 0x3e]))).toBe('REPORT_NOT_UTF8');
  });

  it('enforces the test count limit', () => {
    const xml = `<testsuite>${'<testcase name="t"/>'.repeat(101)}</testsuite>`;
    expect(() => parse(xml)).toThrow(ReportTooLargeError);
  });
});

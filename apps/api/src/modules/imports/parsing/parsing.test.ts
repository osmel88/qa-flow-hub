import { describe, expect, it } from 'vitest';
import { ImportTooLargeError, UnsupportedFileTypeError, ValidationError } from '../../../errors';
import { findInFileDuplicates } from '../import-plan';
import { safeFileName } from '../imports.service';
import { QAFLOW_DIALECT, validateCases } from './case-draft';
import { CsvLimits, decodeCsvText, detectDelimiter, parseCsvTable } from './csv-input';
import { parseQaflowCsv } from './qaflow-csv.parser';
import { TESTRAIL_DIALECT, parseTestrailCsv, testrailEstimateMinutes } from './testrail-csv.parser';

const LIMITS: CsvLimits = {
  maxBytes: 1024 * 1024,
  maxRows: 1000,
  maxColumns: 100,
  maxRecordBytes: 64 * 1024,
};

const table = (text: string, limits: CsvLimits = LIMITS) => parseCsvTable(text, limits);
const qaflow = (text: string) => {
  const parsed = parseQaflowCsv(table(text));
  const validated = validateCases(parsed.cases, QAFLOW_DIALECT);
  return { drafts: validated.drafts, issues: [...parsed.issues, ...validated.issues] };
};
const testrail = (text: string) => {
  const parsed = parseTestrailCsv(table(text));
  const validated = validateCases(parsed.cases, TESTRAIL_DIALECT);
  return { drafts: validated.drafts, issues: [...parsed.issues, ...validated.issues] };
};

describe('decodeCsvText', () => {
  it('strips a UTF-8 BOM and keeps Unicode', () => {
    expect(decodeCsvText(Buffer.from('\uFEFFtitle\nAñadir 日本\n'), 1024)).toBe(
      'title\nAñadir 日本\n',
    );
  });

  it('refuses files above the byte limit before decoding them', () => {
    expect(() => decodeCsvText(Buffer.alloc(2048, 0x61), 1024)).toThrow(ImportTooLargeError);
  });

  it('refuses empty files', () => {
    expect(() => decodeCsvText(Buffer.alloc(0), 1024)).toThrow(ValidationError);
  });

  it.each([
    ['XLSX renamed to .csv', [0x50, 0x4b, 0x03, 0x04, 0x14]],
    ['legacy XLS', [0xd0, 0xcf, 0x11, 0xe0, 0xa1]],
    ['PDF', [0x25, 0x50, 0x44, 0x46, 0x2d]],
    ['gzip', [0x1f, 0x8b, 0x08]],
    ['UTF-16 LE', [0xff, 0xfe, 0x74, 0x00]],
    ['NUL bytes', [0x74, 0x00, 0x69]],
    ['invalid UTF-8', [0x74, 0x69, 0xc3, 0x28]],
  ])('refuses %s', (_label, bytes) => {
    expect(() => decodeCsvText(Buffer.from(bytes), 1024)).toThrow(UnsupportedFileTypeError);
  });
});

describe('parseCsvTable', () => {
  it('detects semicolon-delimited files (European Excel)', () => {
    expect(detectDelimiter('title;priority\nA;high')).toBe(';');
    expect(table('title;priority\nLogin works;high\n').records[0]?.cells).toEqual([
      'Login works',
      'high',
    ]);
  });

  it('handles quotes, escaped quotes and multiline cells, reporting the starting line', () => {
    const parsed = table('title,description\n"Say ""hi""","line 1\nline 2"\nNext,x\n');
    expect(parsed.records[0]).toEqual({ line: 2, cells: ['Say "hi"', 'line 1\nline 2'] });
    expect(parsed.records[1]?.line).toBe(4);
  });

  it('reports malformed CSV without echoing the cell', () => {
    expect(() => table('title,priority\n"unclosed secret,high\n')).toThrow(ValidationError);
    try {
      table('title,priority\nA,high,extra-secret-value\n');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as Error).message).not.toContain('extra-secret-value');
    }
  });

  it('enforces the row, column and record-size limits', () => {
    const rows = ['title', ...Array.from({ length: 6 }, (_, i) => `Case ${i}`)].join('\n');
    expect(() => table(rows, { ...LIMITS, maxRows: 5 })).toThrow(ImportTooLargeError);
    expect(() => table('a,b,c\n1,2,3', { ...LIMITS, maxColumns: 2 })).toThrow(ImportTooLargeError);
    expect(() => table(`title\n${'x'.repeat(200)}`, { ...LIMITS, maxRecordBytes: 100 })).toThrow(
      ValidationError,
    );
  });

  it('needs a header and at least one data row', () => {
    expect(() => table('title\n')).toThrow(ValidationError);
  });
});

describe('qa-flow-hub CSV', () => {
  it('reads one case per row with aliases, enums, tags and references', () => {
    const { drafts, issues } = qaflow(
      'Key,Suite,Section,Title,Type,Priority,Automation_Status,Estimate,Tags,Requirements\n' +
        'C-1,Web,Login > OAuth,Login with Google,smoke,high,automated,15,auth;SSO,web-r-1; WEB-R-2\n',
    );
    expect(issues).toEqual([]);
    expect(drafts[0]).toMatchObject({
      ref: 'C-1',
      suiteName: 'Web',
      sectionPath: ['Login', 'OAuth'],
      type: 'smoke',
      priority: 'high',
      automationStatus: 'automated',
      estimateMinutes: 15,
      tags: ['auth', 'sso'],
      references: ['WEB-R-1', 'WEB-R-2'],
      steps: [],
    });
  });

  it('groups contiguous rows that share a ref into the steps of one case', () => {
    const { drafts } = qaflow(
      'ref,title,step_action,step_expected,step_data\n' +
        'C-1,Checkout,Add item,Cart shows 1,sku=1\n' +
        'C-1,,Pay,Receipt shown,\n' +
        'C-2,Logout,Click logout,,\n',
    );
    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.steps).toEqual([
      { action: 'Add item', expectedResult: 'Cart shows 1', data: 'sku=1' },
      { action: 'Pay', expectedResult: 'Receipt shown', data: null },
    ]);
  });

  it('reports a ref that comes back later, orphan step rows and a missing title column', () => {
    const later = qaflow(
      'ref,title,step_action\nC-1,First case,a\nC-2,Second case,b\nC-1,Again,c\n',
    );
    expect(later.issues).toContainEqual(
      expect.objectContaining({ row: 4, code: 'DUPLICATE_IN_FILE', severity: 'error' }),
    );
    const orphan = qaflow('ref,title,step_action\n,,lonely step\nC-1,Case,a\n');
    expect(orphan.issues).toContainEqual(
      expect.objectContaining({ row: 2, code: 'ORPHAN_STEP_ROW' }),
    );
    const missing = qaflow('name\nA\n');
    expect(missing.issues).toContainEqual(
      expect.objectContaining({ code: 'MISSING_COLUMN', severity: 'error' }),
    );
  });

  it('flags row and column of each problem; unknown enums and columns are warnings', () => {
    const { drafts, issues } = qaflow(
      'title,priority,estimate_minutes,section,custom\n' +
        'ab,high,,,x\n' +
        'Valid case,urgent,abc,,x\n' +
        'Deep case,low,,A>B>C>D>E>F,x\n',
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row: 1,
          column: 'custom',
          code: 'UNKNOWN_COLUMN',
          severity: 'warning',
        }),
        expect.objectContaining({ row: 2, column: 'title', code: 'TOO_SHORT', severity: 'error' }),
        expect.objectContaining({
          row: 3,
          column: 'priority',
          code: 'INVALID_ENUM',
          severity: 'warning',
        }),
        expect.objectContaining({
          row: 3,
          column: 'estimate_minutes',
          code: 'INVALID_NUMBER',
          severity: 'error',
        }),
        expect.objectContaining({
          row: 4,
          column: 'section',
          code: 'SECTION_DEPTH',
          severity: 'error',
        }),
      ]),
    );
    expect(drafts).toEqual([]);
  });

  it('caps the steps of a case', () => {
    const rows = Array.from(
      { length: 101 },
      (_, i) => `C-1,${i === 0 ? 'Long case' : ''},step ${i}`,
    ).join('\n');
    const { issues } = qaflow(`ref,title,step_action\n${rows}\n`);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'TOO_MANY_STEPS' }));
  });

  it('reads escaped separators in qa-flow-hub section paths as part of the name', () => {
    const { drafts, issues } = qaflow(
      'title,section\n' +
        'Escaped levels,"Auth > Login \\> Security > \\>Start > End\\> > a\\\\b"\n' +
        'Only a separator,\\>\n',
    );
    expect(issues).toEqual([]);
    expect(drafts.map((draft) => draft.sectionPath)).toEqual([
      ['Auth', 'Login > Security', '>Start', 'End>', 'a\\b'],
      ['>'],
    ]);
  });

  it('keeps splitting TestRail section hierarchies on every separator', () => {
    const { drafts } = testrail('Title,Section Hierarchy\nTestRail case,Auth > Login \\> MFA\n');
    expect(drafts[0]?.sectionPath).toEqual(['Auth', 'Login \\', 'MFA']);
  });

  it('reads back exported cells that were neutralized against formula injection', () => {
    const { drafts } = qaflow(`title,description\n"'=HYPERLINK(""x"") case",'+1 call\n`);
    expect(drafts[0]?.title).toBe('=HYPERLINK("x") case');
    expect(drafts[0]?.description).toBe('+1 call');
  });

  it('rejects the same title twice in the same suite and section', () => {
    const { drafts } = qaflow('title,section\nLogin works,A\nlogin   WORKS,A\nLogin works,B\n');
    const { unique, issues } = findInFileDuplicates(drafts, 'Imported');
    expect(unique).toHaveLength(2);
    expect(issues).toEqual([expect.objectContaining({ row: 3, code: 'DUPLICATE_IN_FILE' })]);
  });
});

describe('TestRail CSV', () => {
  it('maps a one-row-per-case export by column name, warning about custom fields', () => {
    const { drafts, issues } = testrail(
      'Section,ID,Title,Type,Priority,Estimate,References,Automation Type,Custom Field\n' +
        'Login,C12,Sign in,Smoke & Sanity,1 - Critical,1h 30m,WEB-R-1,Automated,x\n',
    );
    expect(issues).toEqual([
      expect.objectContaining({
        column: 'Custom Field',
        code: 'UNKNOWN_COLUMN',
        severity: 'warning',
      }),
    ]);
    expect(drafts[0]).toMatchObject({
      ref: 'C12',
      sectionPath: ['Login'],
      type: 'smoke',
      priority: 'critical',
      automationStatus: 'automated',
      estimateMinutes: 90,
      references: ['WEB-R-1'],
      status: 'active',
    });
  });

  it('reads separated steps on separate rows', () => {
    const { drafts } = testrail(
      'ID,Title,Steps (Step),Steps (Expected Result)\n' +
        'C1,Checkout,Open cart,Cart open\n' +
        ',,Pay,Paid\n' +
        'C2,Logout,Click logout,Signed out\n',
    );
    expect(drafts.map((draft) => draft.steps.length)).toEqual([2, 1]);
    expect(drafts[0]?.steps[1]).toEqual({ action: 'Pay', expectedResult: 'Paid', data: null });
  });

  it('reports duplicate IDs and step rows before any case', () => {
    const { issues } = testrail('ID,Title,Steps (Step)\n,,early\nC1,One case,a\nc1,Same case,b\n');
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 2, code: 'ORPHAN_STEP_ROW' }),
        expect.objectContaining({ row: 4, code: 'DUPLICATE_IN_FILE' }),
      ]),
    );
  });

  it.each([
    ['90', 2],
    ['30m', 30],
    ['1h 30m', 90],
    ['1d', 1440],
    ['45s', 1],
    ['soon', null],
  ])('converts the estimate %s', (value, minutes) => {
    expect(testrailEstimateMinutes(value)).toBe(minutes);
  });
});

describe('safeFileName', () => {
  it('keeps only a printable base name', () => {
    expect(safeFileName('../../etc/cases.csv')).toBe('cases.csv');
    expect(safeFileName('C:\\Users\\me\\cases\u0007.csv')).toBe('cases.csv');
    expect(safeFileName('   ')).toBe('import.csv');
  });
});

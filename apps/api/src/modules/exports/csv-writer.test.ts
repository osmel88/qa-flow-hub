import { describe, expect, it } from 'vitest';
import { restoreCsvFormula } from '@qa-flow-hub/shared';
import { parse } from 'csv-parse/sync';
import {
  UTF8_BOM,
  attachmentDisposition,
  csvCell,
  csvDocument,
  exportFileName,
} from './csv-writer';

describe('csv writer', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line 1\nline 2')).toBe('"line 1\nline 2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(15)).toBe('15');
  });

  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx'])(
    'neutralizes the formula %j',
    (value) => {
      expect(csvCell(value).replace(/^"|"$/g, '').startsWith("'")).toBe(true);
    },
  );

  it('starts with a BOM and round-trips through a CSV parser', () => {
    const values = ['Añadir "日本", ok', 'multi\nline', '=HYPERLINK("http://evil")', 'plain'];
    const document = csvDocument(['a', 'b', 'c', 'd'], [values]);
    expect(document.startsWith(UTF8_BOM)).toBe(true);
    const rows = parse(document.slice(1));
    expect(rows[1]?.map(restoreCsvFormula)).toEqual(values);
  });

  it('builds a Content-Disposition that cannot be broken out of', () => {
    const header = attachmentDisposition('Run "1"\r\nSet-Cookie: x.csv');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''/);
    expect(header).not.toContain('"1"');
  });

  it('names files from their parts and the date', () => {
    expect(exportFileName('WEB', 'Sprint 1 / Ünïcode')).toMatch(
      /^WEB-Sprint-1-Ünïcode-\d{4}-\d{2}-\d{2}\.csv$/,
    );
  });
});

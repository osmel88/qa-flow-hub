import { neutralizeCsvFormula } from '@qa-flow-hub/shared';

/** Excel opens a UTF-8 CSV as UTF-8 only when it starts with a BOM. */
export const UTF8_BOM = '\uFEFF';

/**
 * One RFC 4180 cell. Every value goes through formula neutralization first: a
 * title such as `=HYPERLINK(...)` typed by any member must arrive in the
 * spreadsheet of whoever downloads it as text, never as a formula.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = typeof value === 'number' ? String(value) : neutralizeCsvFormula(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(values: ReadonlyArray<string | number | null | undefined>): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

export function csvDocument(
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
): string {
  return UTF8_BOM + csvLine(header) + rows.map(csvLine).join('');
}

/**
 * RFC 6266 attachment header. The fallback name keeps only safe ASCII, so a
 * project or run name cannot break out of the quoted string.
 */
export function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 150) || 'export.csv';
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function exportFileName(...parts: string[]): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${parts
    .map((part) =>
      part
        .trim()
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter(Boolean)
    .join('-')}-${stamp}.csv`;
}

import { parse } from 'csv-parse/sync';
import { ValidationError, ImportTooLargeError, UnsupportedFileTypeError } from '../../../errors';

export interface CsvLimits {
  maxBytes: number;
  maxRows: number;
  maxColumns: number;
  maxRecordBytes: number;
}

export const DEFAULT_MAX_COLUMNS = 100;
export const DEFAULT_MAX_RECORD_BYTES = 64 * 1024;

export interface CsvRecord {
  /** 1-based line where the record starts, the header being line 1. */
  line: number;
  cells: string[];
}

export interface CsvTable {
  header: string[];
  records: CsvRecord[];
}

/** Signatures of containers that are not text, whatever the extension says. */
const BINARY_SIGNATURES: ReadonlyArray<{ bytes: number[]; label: string }> = [
  { bytes: [0x50, 0x4b, 0x03, 0x04], label: 'a ZIP archive (XLSX, DOCX…)' },
  { bytes: [0xd0, 0xcf, 0x11, 0xe0], label: 'a legacy Office document (XLS)' },
  { bytes: [0x25, 0x50, 0x44, 0x46], label: 'a PDF' },
  { bytes: [0x1f, 0x8b], label: 'a gzip archive' },
];

const UTF16_BOMS: ReadonlyArray<number[]> = [
  [0xff, 0xfe],
  [0xfe, 0xff],
];

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => buffer[index] === byte);
}

/**
 * Turns the untrusted bytes into text, or refuses them. Only UTF-8 is accepted
 * (with or without BOM): guessing a legacy encoding silently corrupts accents,
 * and a corrupted title imported 2000 times is worse than a clear refusal.
 */
export function decodeCsvText(buffer: Buffer, maxBytes: number): string {
  if (buffer.length > maxBytes) {
    throw new ImportTooLargeError('bytes', maxBytes);
  }
  if (buffer.length === 0) {
    throw new ValidationError('The file is empty');
  }
  for (const signature of BINARY_SIGNATURES) {
    if (startsWith(buffer, signature.bytes)) {
      throw new UnsupportedFileTypeError(
        `The file is ${signature.label}, not a CSV. Export it as CSV (UTF-8)`,
      );
    }
  }
  if (UTF16_BOMS.some((bom) => startsWith(buffer, bom))) {
    throw new UnsupportedFileTypeError('The file is UTF-16; save it as CSV UTF-8');
  }
  if (buffer.includes(0)) {
    throw new UnsupportedFileTypeError(
      'The file contains binary data (NUL bytes); it is not a CSV',
    );
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new UnsupportedFileTypeError('The file is not valid UTF-8; save it as CSV UTF-8');
  }
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

/** `,` unless the header line clearly uses `;` (Excel in many European locales). */
export function detectDelimiter(text: string): ',' | ';' {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const count = (char: string): number => firstLine.split(char).length - 1;
  return count(';') > count(',') ? ';' : ',';
}

/**
 * RFC 4180 parsing with every structural limit enforced by the parser itself,
 * so a hostile file is refused before it is fully materialized.
 */
export function parseCsvTable(text: string, limits: CsvLimits): CsvTable {
  let rows: Array<{ record: string[]; info: { lines: number } }>;
  try {
    rows = parse(text, {
      delimiter: detectDelimiter(text),
      info: true,
      relax_column_count: false,
      relax_quotes: false,
      skip_empty_lines: true,
      skip_records_with_empty_values: true,
      max_record_size: limits.maxRecordBytes,
      // Header + the allowed rows + one more, so an oversized file is detected
      // without parsing the rest of it.
      to: limits.maxRows + 2,
      cast: false,
    }) as unknown as Array<{ record: string[]; info: { lines: number } }>;
  } catch (error) {
    throw new ValidationError(describeParseError(error));
  }

  const [header, ...records] = rows;
  if (header === undefined) {
    throw new ValidationError('The file has no header row');
  }
  if (header.record.length > limits.maxColumns) {
    throw new ImportTooLargeError('columns', limits.maxColumns);
  }
  if (records.length > limits.maxRows) {
    throw new ImportTooLargeError('rows', limits.maxRows);
  }
  if (records.length === 0) {
    throw new ValidationError('The file has a header but no data rows');
  }

  // `info.lines` is the line where the record *ends*. Subtracting the line
  // breaks inside its quoted cells gives the line where it starts, which is
  // what a person looks for in a spreadsheet.
  const parsed: CsvRecord[] = records.map(({ record, info }) => ({
    line:
      info.lines - record.reduce((breaks, cell) => breaks + (cell.match(/\n/g)?.length ?? 0), 0),
    cells: record,
  }));

  return { header: header.record.map((name) => name.trim()), records: parsed };
}

/**
 * The parser's messages quote the offending input; only the code and the line
 * reach the client, so a hostile cell is never echoed back verbatim.
 */
function describeParseError(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'CSV_ERROR';
    const line =
      'lines' in error && typeof error.lines === 'number' ? ` near line ${error.lines}` : '';
    if (code === 'CSV_MAX_RECORD_SIZE') {
      return `A record exceeds the maximum size${line}`;
    }
    if (code === 'CSV_RECORD_INCONSISTENT_FIELDS_LENGTH') {
      return `A row has a different number of columns than the header${line}`;
    }
    if (code === 'CSV_QUOTE_NOT_CLOSED' || code.startsWith('CSV_INVALID_CLOSING_QUOTE')) {
      return `A quoted cell is not closed correctly${line}`;
    }
    return `The CSV is malformed (${code})${line}`;
  }
  return 'The CSV is malformed';
}

import ExcelJS from 'exceljs';

/**
 * Разбор входных файлов импорта (§5.3, IMP-01).
 *
 * Поддерживаются CSV (разделитель определяется автоматически, учитываются кавычки,
 * экранирование кавычек удвоением, переводы строк внутри ячеек, BOM) и XLSX
 * (первый лист). Разбор выполняется на сервере, чтобы правила одинаково
 * применялись независимо от браузера (IMP-01, API-05).
 */

export interface ParsedSheet {
  headers: string[];
  rows: Record<string, string>[];
  /** Номера строк исходного файла, начиная с 2 (первая строка — заголовки). */
  rowNumbers: number[];
}

export class FileParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileParseError';
  }
}

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04 (zip)

export function detectFormat(fileName: string, buffer: Buffer): 'XLSX' | 'CSV' {
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(XLSX_MAGIC)) return 'XLSX';
  if (/\.xlsx$/i.test(fileName)) return 'XLSX';
  if (/\.csv$/i.test(fileName)) return 'CSV';
  // Нет расширения — пробуем по содержимому; текст с разделителями считаем CSV.
  return 'CSV';
}

export async function parseSheet(fileName: string, buffer: Buffer): Promise<ParsedSheet> {
  const format = detectFormat(fileName, buffer);
  const table = format === 'XLSX' ? await readXlsx(buffer) : parseDelimited(stripBom(buffer.toString('utf8')));
  return toSheet(table);
}

/** RFC 4180-совместимый разбор с автоопределением разделителя (; , tab |). */
export function parseDelimited(text: string): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // Пустые хвостовые строки не несут данных.
  return rows.filter((r) => r.some((v) => v.trim().length > 0));
}

function detectDelimiter(text: string): string {
  const sample = text.slice(0, 8192);
  const candidates = [';', ',', '\t', '|'];
  let best = ';';
  let bestCount = -1;
  for (const d of candidates) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < sample.length; i += 1) {
      const ch = sample[i]!;
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && ch === d) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readXlsx(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new FileParseError('Не удалось прочитать книгу XLSX. Сохраните файл в формате .xlsx.');
  }
  const sheet = wb.worksheets[0];
  if (!sheet) throw new FileParseError('В книге XLSX нет ни одного листа.');

  const table: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    const count = Math.max(row.cellCount, row.actualCellCount);
    for (let c = 1; c <= count; c += 1) {
      values.push(cellToString(row.getCell(c).value));
    }
    table.push(values);
  });
  return table;
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const rich = value as { richText?: { text: string }[]; text?: string; result?: unknown; hyperlink?: string };
    if (Array.isArray(rich.richText)) return rich.richText.map((p) => p.text).join('');
    if (typeof rich.text === 'string') return rich.text;
    if (rich.hyperlink) return rich.hyperlink;
    if ('result' in rich) return cellToString(rich.result);
    return JSON.stringify(value);
  }
  return String(value);
}

function toSheet(table: string[][]): ParsedSheet {
  if (table.length === 0) throw new FileParseError('Файл не содержит данных.');
  const headerRow = table[0]!;
  const headers = headerRow.map((h, i) => {
    const clean = h.trim();
    return clean.length > 0 ? clean : `column_${i + 1}`;
  });
  const width = headers.length;
  const rows: Record<string, string>[] = [];
  const rowNumbers: number[] = [];

  for (let r = 1; r < table.length; r += 1) {
    const source = table[r]!;
    const record: Record<string, string> = {};
    for (let c = 0; c < width; c += 1) {
      record[headers[c]!] = (source[c] ?? '').trim();
    }
    rows.push(record);
    rowNumbers.push(r + 1);
  }
  return { headers, rows, rowNumbers };
}

/** Числовое значение строки с поддержкой запятой как десятичного разделителя. */
export function toNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw.replace(/\s| /g, '').replace(',', '.');
  if (cleaned.length === 0) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : Number.NaN;
}
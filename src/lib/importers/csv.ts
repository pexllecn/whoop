/** RFC 4180 CSV parsing (quoted fields, escaped quotes, CRLF/LF, UTF-8 BOM). */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new Error('CSV ends inside a quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Header key normalisation: lowercase, alphanumerics only ("Day Strain" -> "daystrain"). */
export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface CsvTable {
  headers: string[];
  normalized: string[];
  rows: string[][];
}

export function parseCsvTable(text: string): CsvTable {
  const [headers = [], ...rows] = parseCsv(text);
  return { headers, normalized: headers.map(normalizeHeader), rows };
}

/** Accessor that resolves a field by any of several header aliases. */
export function columnReader(table: CsvTable) {
  const index = new Map<string, number>();
  table.normalized.forEach((h, i) => {
    if (!index.has(h)) index.set(h, i);
  });
  const find = (aliases: string[]): number | undefined => {
    for (const alias of aliases) {
      const at = index.get(normalizeHeader(alias));
      if (at !== undefined) return at;
    }
    return undefined;
  };
  return {
    has: (aliases: string[]) => find(aliases) !== undefined,
    text: (row: string[], aliases: string[]): string | null => {
      const at = find(aliases);
      if (at === undefined) return null;
      const value = row[at]?.trim() ?? '';
      return value === '' ? null : value;
    },
    number: (row: string[], aliases: string[]): number | null => {
      const at = find(aliases);
      if (at === undefined) return null;
      const raw = row[at]?.trim().replace(/%$/, '') ?? '';
      if (raw === '') return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    },
    unmatched: (known: string[][]): string[] => {
      const knownSet = new Set(known.flat().map(normalizeHeader));
      return table.headers.filter((_, i) => !knownSet.has(table.normalized[i]!));
    },
  };
}

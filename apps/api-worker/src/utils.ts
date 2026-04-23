export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toSqlLike(value: string): string {
  return `%${value.replaceAll('%', '').replaceAll('_', '')}%`;
}

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateCodeValue(kind: 'qr' | 'barcode'): string {
  const ts = Date.now().toString(36).toUpperCase();
  let randomPart = '';
  for (let i = 0; i < 12; i += 1) {
    randomPart += B32[Math.floor(Math.random() * B32.length)];
  }
  const prefix = kind === 'qr' ? 'QR' : 'BC';
  return `${prefix}-${ts}-${randomPart}`;
}

export function toCsv(rows: Array<Record<string, unknown>>, orderedColumns: string[]): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) {
      return '';
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text.includes(',') || text.includes('"') || text.includes('\n')) {
      return `"${text.replaceAll('"', '""')}"`;
    }
    return text;
  };

  const lines = [orderedColumns.join(',')];
  for (const row of rows) {
    lines.push(orderedColumns.map((column) => escape(row[column])).join(','));
  }
  return lines.join('\n');
}

/**
 * CSV for audit export. Quotes every cell that needs it and defuses spreadsheet formulas:
 * a cell that starts with = + - @ tab or CR would run as a formula when opened in Excel, so it
 * gets a leading apostrophe. Audit summaries contain user-typed names and notes, so this matters.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: readonly unknown[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

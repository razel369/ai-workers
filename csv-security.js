// Spreadsheet-safe CSV encoding. Excel and Google Sheets may evaluate cells
// beginning with formula sigils even when the CSV value is quoted. Prefix an
// apostrophe before any such sigil, including after invisible/whitespace
// characters, then apply normal RFC 4180-style quoting.

const FORMULA_PREFIX = /^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]*[=+\-@]/u;

export function csvCell(value) {
  let text = String(value ?? '');
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  return /[,"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values) {
  return values.map(csvCell).join(',');
}

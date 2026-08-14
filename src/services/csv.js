// Minimal CSV writer — no external dependency needed for this. Handles quoting
// of values containing commas, quotes, or newlines per RFC 4180.
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// rows: array of plain objects. columns: optional ordered [key, ...] — if
// omitted, uses the union of keys across all rows (first-seen order).
export function toCsv(rows, columns) {
  if (!columns) {
    const seen = new Set();
    columns = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
  }
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map(c => csvCell(r[c])).join(','));
  return lines.join('\r\n');
}

export function sendCsv(res, filename, rows, columns) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(rows, columns));
}

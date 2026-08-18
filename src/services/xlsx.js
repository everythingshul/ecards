import xlsx from 'xlsx';

// rows: array of plain objects. columns: optional ordered [key, ...] — if
// omitted, uses the union of keys across all rows (first-seen order). Same
// column-ordering contract as the old CSV writer this replaces — CSV was
// dropped because it doesn't reliably round-trip Hebrew text; Excel does.
export function sendXlsx(res, filename, rows, columns) {
  if (!columns) {
    const seen = new Set();
    columns = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
  }
  const wb = xlsx.utils.book_new();
  const sheet = xlsx.utils.json_to_sheet(rows.length ? rows : [{}], { header: columns });
  xlsx.utils.book_append_sheet(wb, sheet, 'Sheet1');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}

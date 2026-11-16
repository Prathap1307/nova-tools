function cell(value) {
  let text = String(value ?? '');
  if (/^\s*[=+\-@]|^[\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}


export function rowsToCsv(rows) {
  return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

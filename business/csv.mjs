export function readCsv(input) {
  const csv = input.replace(/^\uFEFF/, '');
  const field = /(?:"((?:[^"]|"")*)"|([^",\r\n]*))(,|\r\n|\n|\r|$)/y;
  const rows = [];
  let cells = [];
  let line = 1;
  let rowLine = 1;
  let position = 0;

  while (position < csv.length || cells.length) {
    field.lastIndex = position;
    const match = field.exec(csv);
    if (!match) throw new Error('Invalid CSV syntax at line ' + line);
    const [, quoted, plain, delimiter] = match;
    cells.push(quoted === undefined ? plain : quoted.replace(/""/g, '"'));
    position = field.lastIndex;
    line += (match[0].match(/\r\n|\n|\r/g) ?? []).length;
    if (delimiter !== ',') {
      if (cells.length > 1 || cells[0].trim()) rows.push({ line: rowLine, cells });
      cells = [];
      rowLine = line;
    }
  }
  return rows;
}

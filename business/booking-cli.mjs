import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { analyzeBookingCsv } from './booking-csv.mjs';

try {
  const { values } = parseArgs({ options: {
    file: { type: 'string' },
    date: { type: 'string' },
    'time-zone': { type: 'string', default: 'Europe/London' }
  } });
  if (!values.file || !values.date) throw new Error('Use --file <csv> --date <YYYY-MM-DD>');
  const report = analyzeBookingCsv(await readFile(values.file, 'utf8'), {
    date: values.date, timeZone: values['time-zone']
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.findings.length) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

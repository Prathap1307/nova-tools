import { readFile } from 'node:fs/promises';
import { accessReport, financeReport, healthReport, marketingReport, operationsReport, supportReport } from './reports.mjs';

const tools = new Map([
  ['access', accessReport], ['health', healthReport], ['operations', operationsReport],
  ['finance', financeReport], ['marketing', marketingReport], ['support', supportReport]
]);

try {
  const [, , name, file, ...extra] = process.argv;
  if (!tools.has(name) || !file || extra.length) {
    throw new Error('Usage: npm run business -- <' + [...tools.keys()].join('|') + '> <input.json>');
  }
  const input = JSON.parse(await readFile(file, 'utf8'));
  console.log(JSON.stringify({ tool: name, report: tools.get(name)(input) }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

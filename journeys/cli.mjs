import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { checkJourney } from './check.mjs';

const usage = 'npm run journey -- --config journeys/config/simpleparking-t3.json [--export journey.json] [--screenshot failure.png]';
try {
  const { values } = parseArgs({ options: { config: { type: 'string' }, export: { type: 'string' },
    screenshot: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) console.log(usage);
  else {
    if (!values.config) throw new Error(usage);
    const config = JSON.parse((await readFile(values.config, 'utf8')).replace(/^\uFEFF/, ''));
    const report = await checkJourney(config, { screenshot: values.screenshot });
    const output = JSON.stringify(report, null, 2) + '\n';
    if (values.export) await writeFile(values.export, output, { flag: 'wx' });
    process.stdout.write(output);
    if (report.outcome !== 'pass') process.exitCode = report.outcome === 'fail' ? 2 : 3;
  }
} catch (error) {
  console.error('Journey check failed: ' + error.message);
  process.exitCode = 1;
}

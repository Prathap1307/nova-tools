import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { scoreCases, systemPrompt } from './evaluate.mjs';

try {
  const { values } = parseArgs({ options: {
    cases: { type: 'string', default: new URL('./cases.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') },
    predictions: { type: 'string' }, model: { type: 'string' }, output: { type: 'string' }
  } });
  if (Boolean(values.model) === Boolean(values.predictions)) throw new Error('Supply either --model or --predictions');
  const cases = JSON.parse(await readFile(values.cases, 'utf8'));
  const predictions = values.predictions ? JSON.parse(await readFile(values.predictions, 'utf8')) : [];
  if (values.model) {
    for (const row of cases) {
      try {
        const response = await fetch('http://127.0.0.1:11434/api/chat', {
          method: 'POST', signal: AbortSignal.timeout(120000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: values.model, stream: false, format: 'json',
            options: { temperature: 0 }, messages: [{ role: 'system', content: systemPrompt },
              ...(row.history ?? []).map(content => ({ role: 'user', content })),
              { role: 'user', content: row.text }] })
        });
        if (!response.ok) throw new Error('Local model HTTP ' + response.status);
        const body = await response.json();
        predictions.push({ id: row.id, output: JSON.parse(body.message.content) });
      } catch (error) {
        predictions.push({ id: row.id, error: error.message });
      }
    }
  }
  const report = { model: values.model ?? null, ...scoreCases(cases, predictions) };
  if (values.output) await writeFile(values.output, JSON.stringify({ predictions, report }, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.passed !== report.total) process.exitCode = 2;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

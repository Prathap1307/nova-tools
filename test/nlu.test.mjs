import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { scoreCases } from '../nlu/evaluate.mjs';

const cases = JSON.parse(readFileSync(new URL('../nlu/cases.json', import.meta.url)));
test('NLU evaluation detects missing, wrong and invalid model predictions', () => {
  const predictions = cases.map(row => ({ id: row.id, output: row.expected }));
  assert.equal(scoreCases(cases, predictions).passed, cases.length);
  const wrong = structuredClone(predictions);
  wrong[0].output.intent = 'clarify';
  wrong[1].output.managers = ['unknown'];
  wrong.pop();
  const result = scoreCases(cases, wrong);
  assert.equal(result.passed, cases.length - 3);
  assert.ok(result.results[1].error);
  assert.match(result.results.at(-1).error, /Missing/);
  assert.throws(() => scoreCases(cases, [...predictions, predictions[0]]), /duplicate/);
});

test('manager order is equivalent and multilingual cases retain separate scores', () => {
  const row = cases.find(row => row.expected.managers.length === 2);
  assert.equal(scoreCases([row], [{ id: row.id, output: {
    ...row.expected, managers: [...row.expected.managers].reverse()
  } }]).passed, 1);
  assert.deepEqual(Object.keys(scoreCases(cases, []).languages), ['en', 'ta', 'tanglish']);
});

const escape = value => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>]/g, '\\$&');
const status = {
  covered: 'Covered', partly_covered: 'Partly covered', missing: 'Missing',
  needs_verification: 'Needs verification'
};

export function briefMarkdown(report) {
  const lines = ['# Page brief', '', '**Target page** ' + report.target,
    '**Keyword group** ' + escape(report.keyword), '',
    'Based on saved captures. Confirm operational claims before publishing.', '', '## Prioritized actions', ''];
  for (const item of report.actions) {
    lines.push('- **' + item.priority.toUpperCase() + ' · ' + item.id + '** ' + escape(item.action) + (item.owner ? ' **Owner** ' + escape(item.owner) : ''));
    if (item.evidence) lines.push('  - Snapshot ' + item.evidence.snapshotId
      + ' declares ' + item.evidence.declaredCanonical + '.');
  }
  if (!report.actions.length) lines.push('No gaps were identified in this checklist.');
  if (report.journey) {
    const { journey } = report;
    lines.push('', '## Quote journey evidence', '',
      '- ' + escape(journey.cta) + ' · ' + escape(journey.outcome) + '. Final URL ' + escape(journey.finalUrl) + '.',
      '- Checked ' + escape(journey.checkedAt) + '.');
    if (journey.terminal) lines.push('- Terminal marker visible in quote panel: ' + (journey.terminal.visible ? 'yes' : 'no') + '.');
  }
  lines.push('', '## Customer questions and evidence', '');
  for (const question of report.questions) {
    lines.push('### ' + escape(question.question), '', '**' + status[question.status] + '**. ' + escape(question.action), '');
    for (const criterion of question.criteria) {
      lines.push('- **' + escape(criterion.label) + '**');
      for (const [label, items] of [['Target', criterion.target ? [criterion.target] : []], ['Support', criterion.supporting]]) {
        if (!items.length && label === 'Target') lines.push('  - Target excerpt unavailable in saved capture.');
        for (const item of items) lines.push('  - ' + label + ', snapshot ' + item.snapshotId
          + ' (' + item.url + '). “' + escape(item.excerpt) + '”');
      }
    }
    for (const link of question.existingLinks) lines.push('- Existing link: ' + escape(link.anchor) + ' (' + link.url + ').');
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

const severity = { critical: 0, high: 1, medium: 2, low: 3 };

export function prioritize({ audit, links, journey, brief }) {
  const fixes = [];
  if (journey?.outcome === 'fail') {
    const failedStep = journey.steps.find(step => step.outcome === 'fail');
    fixes.push({ type: 'booking_journey', severity: 'critical',
      action: 'Fix and rerun the failed booking step.',
      evidence: { url: journey.sourceUrl, cta: journey.cta, failedStep, screenshot: journey.screenshot } });
  }
  for (const result of links?.results ?? []) {
    if (result.outcome !== 'broken' && result.outcome !== 'review') continue;
    fixes.push({ type: 'link_health', severity: result.quoteOrBooking ? 'high' : 'medium',
      action: 'Review the destination and update the listed source links where appropriate.',
      evidence: { destination: result.url, finalUrl: result.finalUrl, status: result.status,
        reason: result.reason, signals: result.signals, sources: result.sources } });
  }
  for (const finding of audit?.findings ?? []) {
    if (finding.severity === 'info') continue;
    fixes.push({ type: 'seo_audit', severity: finding.severity, code: finding.code,
      action: finding.nextStep, affectedCount: finding.affectedCount, evidence: finding.affected });
  }
  for (const action of brief?.actions ?? []) {
    if (action.id === 'canonical' && fixes.some(item => item.code === 'homepage_canonical'
        && item.evidence.some(page => page.requestedUrl === brief.target))) continue;
    fixes.push({ type: 'content_brief', severity: action.priority, code: action.id, action: action.action,
      owner: action.owner, evidence: action.evidence ?? brief.questions?.find(question => question.id === action.id)?.criteria ?? brief.journey });
  }
  const typeOrder = { booking_journey: 0, link_health: 1, seo_audit: 2, content_brief: 3 };
  return fixes.sort((a, b) => severity[a.severity] - severity[b.severity]
    || typeOrder[a.type] - typeOrder[b.type] || (b.affectedCount ?? 0) - (a.affectedCount ?? 0));
}

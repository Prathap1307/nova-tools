import { rowsToCsv } from '../report/csv.mjs';

const columns = [
  'Severity', 'Code', 'Issue', 'Affected Pages', 'Requested URL', 'Final URL',
  'Snapshot ID', 'Raw Snapshot ID', 'Capture Mode', 'Observed At', 'Group Value',
  'Declared Canonical', 'Next Step', 'Evidence'
];

export function auditCsv(report) {
  const captures = new Map(report.pages.map(page => [page.requestedUrl, page]));
  const rows = [columns];
  for (const finding of report.findings) {
    for (const item of finding.affected) {
      const page = captures.get(item.requestedUrl);
      rows.push([finding.severity, finding.code, finding.message, finding.affectedCount,
        item.requestedUrl, item.finalUrl, item.snapshotId, (item.raw ?? page?.raw)?.snapshotId,
        item.captureMode, item.observedAt, finding.value, item.declaredCanonical, finding.nextStep, JSON.stringify(item)]);
    }
  }
  return rowsToCsv(rows);
}

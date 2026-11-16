export function inspectHeaders({ status, headers, url }) {
  const findings = [];
  function add(id, priority, evidence, fix) {
    findings.push({ id, priority, evidence, fix });
  }

  if (status < 200 || status >= 300) {
    add('response-unverified', 'review', 'HTTP ' + status, 'Review headers on a successful page response.');
    return findings;
  }

  if (new URL(url).protocol !== 'https:') {
    add('https-missing', 'high', 'Final URL uses HTTP', 'Serve the page over HTTPS and redirect HTTP traffic.');
  } else {
    const maxAge = headers['strict-transport-security']?.match(/(?:^|;)\s*max-age\s*=\s*(\d+)\s*(?:;|$)/i);
    if (!maxAge || Number(maxAge[1]) === 0) {
      add('hsts-inactive', 'medium', 'No positive HSTS max-age', 'Enable HSTS at the hosting layer after verifying HTTPS coverage.');
    }
  }

  if (!/^text\/html\b|^application\/xhtml\+xml\b/i.test(headers['content-type'] ?? '')) return findings;

  const csp = headers['content-security-policy'];
  if (!csp?.trim()) {
    add('csp-missing', 'medium', headers['content-security-policy-report-only']
      ? 'Only a report-only CSP was observed' : 'No enforcing CSP header observed',
    'Test a policy in report-only mode, then enforce it after validating booking and payment integrations.');
  }
  const hasFrameAncestors = /(?:^|[;,])\s*frame-ancestors\s+[^;,\s]/i.test(csp ?? '');
  if (!hasFrameAncestors && !/^(deny|sameorigin)$/i.test(headers['x-frame-options']?.trim() ?? '')) {
    add('frame-policy-missing', 'medium', 'No frame-ancestors or recognized X-Frame-Options header',
      'Set CSP frame-ancestors to the origins that need to embed the page, or disallow embedding.');
  }
  if (headers['x-content-type-options']?.trim().toLowerCase() !== 'nosniff') {
    add('nosniff-missing', 'low', 'X-Content-Type-Options: nosniff was not observed',
      'Set X-Content-Type-Options to nosniff and check resource Content-Type values.');
  }
  return findings;
}

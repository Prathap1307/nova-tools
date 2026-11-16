export const comparisonFields = ['canonical', 'title', 'description', 'robots', 'xRobotsTag'];

export function compareRenderedFields(raw, rendered) {
  return Object.fromEntries(comparisonFields.map(field => {
    const before = raw[field] ?? null;
    const after = rendered[field] ?? null;
    let status = 'unchanged';
    if (before !== after) {
      status = before === null ? 'added' : after === null ? 'removed' : 'changed';
    }
    return [field, { raw: before, rendered: after, status }];
  }));
}

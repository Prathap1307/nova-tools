import { webUrl } from '../crawler/http.mjs';

function records(text) {
  const lines = [];
  let row = [];
  let value = '';
  let quoted = false;
  let closed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') { quoted = false; closed = true; }
      else value += ch;
      continue;
    }
    if (ch === ',' || ch === '\n' || ch === '\r') {
      row.push(value);
      value = '';
      closed = false;
      if (ch !== ',') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        if (row.some(field => field.trim())) lines.push(row);
        row = [];
      }
    } else if (closed) {
      throw new Error('Unexpected text after a quoted CSV field');
    } else if (ch === '"') {
      if (value) throw new Error('Unexpected quote in CSV field');
      quoted = true;
    } else value += ch;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (value || row.length) lines.push([...row, value]);
  return lines;
}

export function parseSearchConsole(text, hostname) {
  const [header, ...rows] = records(text.replace(/^\uFEFF/, ''));
  const names = header?.map(value => value.trim().toLowerCase());
  const optionalAliases = ['landing url', 'landing page', 'page', 'url'];
  const index = {
    query: names?.findIndex(name => ['query', 'queries', 'top queries'].includes(name)),
    page: names?.findIndex(name => optionalAliases.includes(name)),
    clicks: names?.indexOf('clicks'), impressions: names?.indexOf('impressions'),
    position: names?.findIndex(name => ['position', 'average position'].includes(name))
  };
  if (!names || Object.values(index).some(value => value == null || value < 0))
    throw new Error('CSV needs Query, Page, Clicks, Impressions and Position columns on the same rows');
  let skipped = 0;
  const seen = new Set();
  const entries = [];
  for (const [offset, row] of rows.entries()) {
    if (row.length !== names.length) throw new Error('Wrong column count at CSV row ' + (offset + 2));
    const query = row[index.query].trim();
    const url = webUrl(row[index.page].trim());
    if (url.hostname !== hostname) { skipped++; continue; }
    const raw = ['clicks', 'impressions', 'position'].map(key => row[index[key]].trim());
    const [clicks, impressions, position] = raw.map(Number);
    if (!query || raw.some(value => !value) || !Number.isSafeInteger(clicks) || !Number.isSafeInteger(impressions)
        || clicks < 0 || impressions < clicks || !Number.isFinite(position) || position < 0)
      throw new Error('Invalid metrics at CSV row ' + (offset + 2));
    const key = JSON.stringify([query.normalize('NFKC').toLowerCase(), url.href]);
    if (seen.has(key)) throw new Error('Duplicate query + page at CSV row ' + (offset + 2)
      + '. Supply one reporting period aggregated by query and page.');
    seen.add(key);
    entries.push({ query, page: url.href, clicks, impressions, position });
  }
  return { entries, skipped };
}

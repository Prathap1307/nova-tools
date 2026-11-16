import { loadBuffer } from 'cheerio';
import { webUrl } from './http.mjs';

export const extractionVersion = 3;
const clean = value => value.replace(/\s+/g, ' ').trim();

function normalize(raw, base) {
  if (!raw?.trim()) return null;
  try {
    return webUrl(raw, base).href;
  } catch {
    return null;
  }
}

export function extract(body, finalUrl, headers) {
  const $ = loadBuffer(Buffer.from(body), {
    encoding: { transportLayerEncodingLabel: /charset\s*=\s*["']?([^;\s"']+)/i.exec(headers['content-type'] || '')?.[1] }
  });
  const metadata = name => clean($('meta').filter((_, node) =>
    ($(node).attr('name') || '').toLowerCase() === name).first().attr('content') || '') || null;
  const base = normalize($('base[href]').first().attr('href'), finalUrl) || finalUrl;
  const links = [];
  const quoteLinks = [];
  $('a[href]').each((_, node) => {
    const anchor = $(node);
    const raw = anchor.attr('href');
    if (raw.trim().startsWith('#')) return;
    const url = normalize(raw, base);
    if (!url) return;
    const text = clean(anchor.text()) || clean(anchor.attr('aria-label') || '');
    const type = new URL(url).hostname === new URL(finalUrl).hostname ? 'internal' : 'external';
    links.push({ url, anchor: text, kind: type });
    if (/\bquote\b/i.test(text) || /(?:^|[/-])quote(?:[/-]|$)/i.test(new URL(url).pathname))
      quoteLinks.push({ url, text });
  });

  const canonical = $('link[href]').filter((_, node) =>
    ($(node).attr('rel') || '').toLowerCase().split(/\s+/).includes('canonical')).first();
  const headings = $('h1,h2,h3,h4,h5,h6').map((_, el) => ({
    level: Number(el.tagName.slice(1)), text: clean($(el).text())
  })).get();
  const core = $('main,[role="main"],article').first();
  const text = (core.length ? core : $('body')).clone();
  text.find('script,style,template,noscript,nav,footer,aside,[hidden],[aria-hidden="true"]').remove();
  text.find('h1,h2,h3,h4,h5,h6,p,div,section,li,br,dt,dd,blockquote').append(' ');

  return {
    fields: {
      title: clean($('title').first().text()) || null,
      description: metadata('description'),
      canonical: normalize(canonical.attr('href'), base),
      robots: metadata('robots'),
      xRobotsTag: headers['x-robots-tag'] || null,
      headings,
      quoteLinks,
      mainText: clean(text.text()).slice(0, 50000) || null
    },
    links
  };
}

import { DatabaseSync } from 'node:sqlite';
import { checkJourney } from '../journeys/check.mjs';
import { checkLinks } from '../links/check.mjs';

export async function retryCritical(site, artifacts, { journeyConfig, crawlDb, screenshot } = {}) {
  const links = (artifacts.links?.results ?? []).filter(row => row.quoteOrBooking && row.outcome === 'broken')
    .slice(0, journeyConfig ? 2 : 3);
  const retries = { ...artifacts.retries };
  if (!retries.journey && journeyConfig && artifacts.journey?.outcome === 'fail') {
    const original = artifacts.journey;
    const same = journeyConfig.id === original.id && new URL(journeyConfig.startUrl).href === original.sourceUrl
      && journeyConfig.cta.name === original.cta
      && JSON.stringify(journeyConfig.expected) === JSON.stringify(original.expected);
    if (!same) throw new Error('Retry journey configuration does not match the initial check');
    retries.journey = await checkJourney(journeyConfig, { screenshot });
  }
  if (!retries.links && crawlDb && links.length) {
    const db = new DatabaseSync(crawlDb, { readOnly: true });
    try {
      retries.links = await checkLinks(db, site, { maxLinks: links.length, mode: artifacts.links.mode,
        onlyUrls: new Set(links.map(link => link.url)) });
    } finally {
      db.close();
    }
  }
  return retries;
}

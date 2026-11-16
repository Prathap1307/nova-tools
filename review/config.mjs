import { readFile } from 'node:fs/promises';

export const readJson = async url => JSON.parse((await readFile(url, 'utf8')).replace(/^\uFEFF/, ''));

export async function loadReviewConfig(url) {
  const config = await readJson(url);
  const [brief, journey] = await Promise.all([
    readJson(new URL(config.briefConfig, url)), readJson(new URL(config.journeyConfig, url))
  ]);
  return { brief, journey, siteOptions: config.siteReview };
}

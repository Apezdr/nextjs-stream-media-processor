// lib/metadataUrlHash.mjs
//
// The `?hash=` on a movie's or a show's metadata.json URL. The frontend sync
// keys its metadata refetch on it: a new value makes it fetch metadata.json
// again and rewrite the title's whole metadata subdocument.
//
// It is the sha256 of the metadata.json content the row stores in its
// `metadata` column. Both scanners store that content canonically, as
// JSON.stringify(JSON.parse(file)), or as a {_stat: {mtimeMs, size}} marker
// for a file that does not parse (movie-scanner.mjs's F-1 fingerprint,
// tv-scanner.mjs's processShowMetadata). So the value moves when the content
// does and only then: a subtitle, a sidecar or any other file written into the
// folder leaves it alone, and so does the same JSON written again with other
// whitespace. It used to be the row's directory_hash (every file's name, size
// and mtime in the folder), which moved on all of those.
//
// A row with no stored content falls back to its directory_hash, and that is
// logged once per title. Rows written before F-1 stored the content are the
// only ones expected, and its one-shot backfill (and any payload-version pass)
// rewrites them.

import { createHash } from 'crypto';
import { createCategoryLogger } from './logger.mjs';

const logger = createCategoryLogger('metadataUrlHash');
const fellBack = new Set();

/**
 * The metadata URL's hash for a movies or tv_shows row.
 *
 * @param {'movies'|'tv_shows'} table - For the fallback log
 * @param {{name?: string, metadata?: string|null, directory_hash?: string|null}} row - The raw row
 * @returns {string|null} 64 hex digits, or null when the row has neither
 */
export function metadataUrlHash(table, row) {
  const content = row?.metadata;
  if (typeof content === 'string' && content !== '') {
    return createHash('sha256').update(content).digest('hex');
  }
  const key = `${table}:${row?.name}`;
  if (!fellBack.has(key)) {
    fellBack.add(key);
    logger.warn(
      `${table} row "${row?.name}" stores no metadata.json content; its metadata URL hash falls back to the directory hash until the next scan writes it`
    );
  }
  return row?.directory_hash ?? null;
}

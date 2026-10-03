import { withRetry, initializeDatabase } from '../sqliteDatabase.mjs';

/**
 * Movies and episodes with more than one video file, from the rows the scanner
 * published. The filter runs in SQLite, so only those rows are parsed; the
 * identity service's leftover report reads this.
 *
 * @param {object} [db] - main database; defaults to the shared connection
 * @returns {Promise<Array<{
 *   mediaType: 'movie'|'tv',
 *   libraryRelativePath: string,
 *   title: string,
 *   episode: string|null,
 *   sources: Array<{filename: string, size: number|null, dimensions: string|null, hdr: string|null, isPrimary: boolean}>
 * }>>}
 */
export async function listMultiSourceTitles(db = null) {
  db ??= await initializeDatabase();

  const movies = await withRetry(() => db.all(
    `SELECT name, json_extract(urls, '$.sources') AS sources
       FROM movies
      WHERE json_valid(urls) AND json_array_length(json_extract(urls, '$.sources')) > 1`
  ));

  const episodes = await withRetry(() => db.all(
    `SELECT s.name AS show, e.key AS episode, json_extract(e.value, '$.sources') AS sources
       FROM (SELECT name, seasons FROM tv_shows WHERE json_valid(seasons)) s,
            json_each(s.seasons) se,
            json_each(json_extract(se.value, '$.episodes')) e
      WHERE json_array_length(json_extract(e.value, '$.sources')) > 1`
  ));

  return [
    ...movies.map((row) => ({
      mediaType: 'movie',
      libraryRelativePath: `movies/${row.name}`,
      title: row.name,
      episode: null,
      sources: sourcesOf(row.sources),
    })),
    ...episodes.map((row) => ({
      mediaType: 'tv',
      libraryRelativePath: `tv/${row.show}`,
      title: row.show,
      episode: row.episode,
      sources: sourcesOf(row.sources),
    })),
  ];
}

function sourcesOf(raw) {
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => typeof s?.filename === 'string' && s.filename)
    .map((s) => ({
      filename: s.filename,
      size: typeof s.size === 'number' ? s.size : null,
      dimensions: s.dimensions ?? null,
      hdr: s.hdr ?? null,
      isPrimary: s.isPrimary === true,
    }));
}

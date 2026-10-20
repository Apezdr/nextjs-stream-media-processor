/**
 * This processor's own ID: a UUID made on first start and kept in its db
 * directory (db/processor-identity.json), so it survives restarts and image
 * updates. Log alert state is keyed by it, since several processors can
 * share one Mongo, and frontends use it to tell one processor's alerts from
 * another's. Nothing else identified a processor before: the UUIDs in .info
 * files belong to media files.
 */

import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// The SQLite files' directory (sqliteDatabase.mjs), with the same test seam.
const dbDirectory = process.env.MEDIA_DB_DIRECTORY || join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const IDENTITY_FILE = 'processor-identity.json';

let cached = null;

export async function getProcessorId({ directory = dbDirectory } = {}) {
  if (cached && directory === dbDirectory) return cached;
  const file = join(directory, IDENTITY_FILE);
  let id;
  try {
    id = JSON.parse(await fs.readFile(file, 'utf8')).id;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!id) {
    await fs.mkdir(directory, { recursive: true });
    const created = { id: randomUUID(), createdAt: new Date().toISOString() };
    try {
      // wx: if another start wrote it first, use theirs.
      await fs.writeFile(file, `${JSON.stringify(created, null, 2)}\n`, { flag: 'wx' });
      id = created.id;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      id = JSON.parse(await fs.readFile(file, 'utf8')).id;
    }
  }
  if (directory === dbDirectory) cached = id;
  return id;
}
